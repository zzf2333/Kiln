import { render } from "preact";
import "./styles/tokens.css";
import "./styles/layout.css";
import { App } from "./app";

const root = document.getElementById("app");
if (root) {
  render(<App />, root);
}
