import type { ComponentChildren } from "preact";
import { useKilnStore } from "../state/store";
import { MenuIcon } from "./Icons";

export interface ViewFrameProps {
  left: ComponentChildren;
  right?: ComponentChildren;
  isBoard?: boolean;
  children: ComponentChildren;
}

export function ViewFrame({ left, right, isBoard, children }: ViewFrameProps) {
  const { store, state } = useKilnStore();

  return (
    <section class="main">
      <header class={`topbar ${isBoard ? "is-board" : ""}`}>
        <button
          type="button"
          class="menu-btn"
          aria-label="打开导航"
          onClick={() => store.setNavOpen(!state.navOpen)}
        >
          <MenuIcon />
        </button>
        <div class="tb-l" id="tbL">
          {left}
        </div>
        <div class="tb-r" id="tbR">
          {right}
        </div>
      </header>
      <div class="view" id="view">
        {children}
      </div>
    </section>
  );
}
