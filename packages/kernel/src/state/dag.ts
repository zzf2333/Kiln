import { PRIORITY_RANK, type Priority, type TaskStatus } from "@kiln/protocol";

export interface ValidateDependsOnOptions {
  /**
   * When true (default), every dependency ID referenced by `candidateDependsOn`
   * must already exist as a key in `existingDeps`.
   */
  requireExistingDeps?: boolean;
}

export interface PriorityGraphNode {
  priority: Priority;
  status: TaskStatus;
  dependsOn: readonly string[];
}

export interface DownstreamGraphNode {
  status: TaskStatus;
  dependsOn: readonly string[];
}

/**
 * Raised when adding or updating `depends_on` edges introduces a dependency cycle.
 */
export class DependencyCycleError extends Error {
  readonly cycle: readonly string[];

  constructor(cycle: readonly string[]) {
    super(`Dependency cycle detected: ${cycle.join(" -> ")}`);
    this.name = "DependencyCycleError";
    this.cycle = [...cycle];
  }
}

/**
 * Raised when `depends_on` references a prerequisite task ID that does not exist.
 */
export class MissingDependencyError extends Error {
  readonly taskId: string;
  readonly missingDepId: string;

  constructor(taskId: string, missingDepId: string) {
    super(`Task "${taskId}" references unknown prerequisite task "${missingDepId}"`);
    this.name = "MissingDependencyError";
    this.taskId = taskId;
    this.missingDepId = missingDepId;
  }
}

function isTerminalStatus(status: TaskStatus): boolean {
  return status === "done" || status === "cancelled";
}

/**
 * Validates that setting `candidateTaskId`'s prerequisites to `candidateDependsOn`
 * keeps the task dependency graph acyclic (via 3-color DFS) and references valid prerequisites.
 */
export function validateDependsOnGraph(
  existingDeps: ReadonlyMap<string, readonly string[]>,
  candidateTaskId: string,
  candidateDependsOn: readonly string[],
  options?: ValidateDependsOnOptions,
): void {
  if (candidateTaskId.trim().length === 0) {
    throw new Error("candidateTaskId must be a non-empty string");
  }

  const requireExistingDeps = options?.requireExistingDeps ?? true;

  for (const depId of candidateDependsOn) {
    if (depId.trim().length === 0) {
      throw new Error(`Task "${candidateTaskId}" contains an empty dependency ID`);
    }
    if (depId === candidateTaskId) {
      throw new DependencyCycleError([candidateTaskId, candidateTaskId]);
    }
    if (requireExistingDeps && !existingDeps.has(depId)) {
      throw new MissingDependencyError(candidateTaskId, depId);
    }
  }

  const graph = new Map<string, readonly string[]>(existingDeps);
  graph.set(candidateTaskId, [...candidateDependsOn]);

  // 0 = unvisited (white), 1 = visiting (gray), 2 = visited (black)
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const dfs = (nodeId: string): void => {
    color.set(nodeId, 1);
    stack.push(nodeId);

    const neighbors = graph.get(nodeId) ?? [];
    for (const depId of neighbors) {
      const depColor = color.get(depId) ?? 0;
      if (depColor === 1) {
        const cycleStart = stack.indexOf(depId);
        const cyclePath = cycleStart >= 0 ? [...stack.slice(cycleStart), depId] : [depId, depId];
        throw new DependencyCycleError(cyclePath);
      }
      if (depColor === 0 && graph.has(depId)) {
        dfs(depId);
      }
    }

    stack.pop();
    color.set(nodeId, 2);
  };

  // Start from candidateTaskId so any cycle introduced by the candidate edge is reported directly.
  dfs(candidateTaskId);

  for (const nodeId of graph.keys()) {
    if ((color.get(nodeId) ?? 0) === 0) {
      dfs(nodeId);
    }
  }
}

/**
 * Propagates higher priorities (lower PRIORITY_RANK) from incomplete (non-terminal)
 * downstream tasks along `depends_on` edges to incomplete upstream prerequisites.
 * Terminal tasks (`done` / `cancelled`) neither receive nor propagate priority boosts.
 */
export function computeEffectivePriorities(
  nodes: ReadonlyMap<string, PriorityGraphNode>,
): Map<string, Priority> {
  const effective = new Map<string, Priority>();
  for (const [taskId, node] of nodes) {
    effective.set(taskId, node.priority);
  }

  const propagatePriority = (
    startId: string,
    sourcePriority: Priority,
  ): void => {
    const startRank = PRIORITY_RANK[sourcePriority];
    const visited = new Set<string>([startId]);
    const stack: string[] = [startId];

    while (stack.length > 0) {
      const currentId = stack.pop()!;
      const node = nodes.get(currentId);
      if (!node || isTerminalStatus(node.status)) {
        continue;
      }

      for (const depId of node.dependsOn) {
        if (visited.has(depId)) {
          continue;
        }
        visited.add(depId);

        const depNode = nodes.get(depId);
        if (!depNode || isTerminalStatus(depNode.status)) {
          continue;
        }

        const depCurrent = effective.get(depId) ?? depNode.priority;
        if (startRank < PRIORITY_RANK[depCurrent]) {
          effective.set(depId, sourcePriority);
          stack.push(depId);
        }
      }
    }
  };

  for (const [taskId, node] of nodes) {
    if (!isTerminalStatus(node.status)) {
      propagatePriority(taskId, node.priority);
    }
  }

  return effective;
}

/**
 * Returns deterministically sorted IDs of all `queued` tasks whose `dependsOn` list
 * directly includes `cancelledTaskId`.
 */
export function findQueuedDownstreamTasks(
  nodes: ReadonlyMap<string, DownstreamGraphNode>,
  cancelledTaskId: string,
): string[] {
  const matched: string[] = [];
  for (const [taskId, node] of nodes) {
    if (node.status === "queued" && node.dependsOn.includes(cancelledTaskId)) {
      matched.push(taskId);
    }
  }
  matched.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return matched;
}
