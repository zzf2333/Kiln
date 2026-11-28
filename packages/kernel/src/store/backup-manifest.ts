import { z } from "zod";

export const HOST_BACKUP_STATUSES = [
  "staged_awaiting_approval",
  "applied",
  "rolled_back",
  "restored",
] as const;

export const HostBackupStatusSchema = z.enum(HOST_BACKUP_STATUSES);
export type HostBackupStatus = z.infer<typeof HostBackupStatusSchema>;

export const HostBackupFileEntrySchema = z.object({
  target_canonical_path: z.string().min(1),
  staged_relative_path: z.string().min(1),
  staged_sha256: z.string().min(1).optional(),
  backup_relative_path: z.string().min(1).nullable(),
  existed_before: z.boolean(),
  pre_sha256: z.string().min(1).nullable(),
  post_sha256: z.string().min(1).nullable(),
  file_mode: z.number().int().min(0).max(0o7777).optional(),
  staged_file_mode: z.number().int().min(0).max(0o7777).optional(),
  updated_at: z.string().min(1),
});
export type HostBackupFileEntry = z.infer<typeof HostBackupFileEntrySchema>;

export const HostBackupManifestSchema = z.object({
  schema_version: z.literal(1),
  task_id: z.string().min(1),
  status: HostBackupStatusSchema,
  files: z.array(HostBackupFileEntrySchema),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});
export type HostBackupManifest = z.infer<typeof HostBackupManifestSchema>;
