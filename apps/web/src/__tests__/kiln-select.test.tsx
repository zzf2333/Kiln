// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KilnSelect } from "../components/KilnSelect";

afterEach(() => {
  cleanup();
});

describe("KilnSelect in-DOM dropdown", () => {
  const opts = [
    { value: "alpha", label: "Alpha Model" },
    { value: "beta", label: "Beta Model" },
    { value: "gamma", label: "Gamma (Disabled)", disabled: true },
    { value: "delta", label: "Delta Model" },
  ];

  it("opens on click, selects an option, and closes without native select", async () => {
    const onChange = vi.fn();
    render(<KilnSelect ariaLabel="主模型选择" value="alpha" options={opts} onChange={onChange} />);

    const trigger = screen.getByRole("combobox", { name: "主模型选择" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("data-value")).toBe("alpha");
    expect(trigger.textContent).toContain("Alpha Model");

    fireEvent.click(trigger);
    const listbox = await screen.findByRole("listbox", { name: "主模型选择" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const deltaOpt = within(listbox)
      .getAllByRole("option")
      .find((el) => el.getAttribute("data-value") === "delta");
    expect(deltaOpt).toBeTruthy();
    fireEvent.click(deltaOpt!);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("delta");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("supports keyboard navigation (ArrowDown / Enter / Escape) and skips disabled options", async () => {
    const onChange = vi.fn();
    render(<KilnSelect ariaLabel="推理档位" value="beta" options={opts} onChange={onChange} />);

    const trigger = screen.getByRole("combobox", { name: "推理档位" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const listbox = await screen.findByRole("listbox", { name: "推理档位" });

    // Moving down from "beta" should skip disabled "gamma" and land on "delta"
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("delta");
    expect(screen.queryByRole("listbox")).toBeNull();

    // Opening again and pressing Escape closes without calling onChange
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const reopened = await screen.findByRole("listbox", { name: "推理档位" });
    fireEvent.keyDown(reopened, { key: "Escape" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("respects disabled state and stopPropagation when nested in a clickable parent", async () => {
    const parentClick = vi.fn();
    const onChange = vi.fn();
    const { rerender } = render(
      <div onClick={parentClick}>
        <KilnSelect
          ariaLabel="优先级"
          value="P1"
          stopPropagation
          options={[
            { value: "P0", label: "P0" },
            { value: "P1", label: "P1" },
          ]}
          onChange={onChange}
        />
      </div>,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "优先级" }));
    const listbox = await screen.findByRole("listbox", { name: "优先级" });
    fireEvent.click(within(listbox).getByRole("option", { name: "P0" }));

    expect(onChange).toHaveBeenCalledWith("P0");
    expect(parentClick).not.toHaveBeenCalled();

    rerender(
      <KilnSelect
        ariaLabel="优先级"
        value="P1"
        disabled
        options={[{ value: "P1", label: "P1" }]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "优先级" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps apps/web non-test components free of native <select> elements", async () => {
    const [{ readdirSync, readFileSync, statSync }, path] = await Promise.all([
      import("node:fs"),
      import("node:path"),
    ]);
    const collectNonTestTsxFiles = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        if (entry === "__tests__") continue;
        const full = path.join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          out.push(...collectNonTestTsxFiles(full));
        } else if (full.endsWith(".tsx")) {
          out.push(full);
        }
      }
      return out;
    };
    const webSrc = path.resolve(import.meta.dirname, "..");
    const files = collectNonTestTsxFiles(webSrc);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      expect(content, `Unexpected native <select> in ${file}`).not.toMatch(/<select[\s>]/);
    }
  });
});
