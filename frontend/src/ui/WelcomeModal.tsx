import { Button, Toggle } from "./components";
import { useStore } from "../store";
import "./WelcomeModal.css";

export function WelcomeModal() {
  const showWelcome = useStore((s) => s.showWelcome);
  const set = useStore((s) => s.set);
  if (!showWelcome) return null;

  return (
    <div className="gz-modal-backdrop">
      <div className="gz-modal">
        <h2>Welcome to gazeCOM</h2>
        <p>
          gazeCOM translates saliency patterns — gaze movements, hand gestures,
          computer vision, or algorithmic walks — into spatial controls for
          iterative image generation and composition across an infinite canvas.
        </p>
        <p>
          Set the ComfyUI and optional Ollama addresses under{" "}
          <strong>General</strong> in the settings drawer opened by the{" "}
          <strong>⚙</strong> button. Then choose a tracking mode under{" "}
          <strong>Settings</strong> and pin a generation workflow under{" "}
          <strong>Workflow</strong> in the panel. Hit{" "}
          <strong>Start tracking</strong>, then <strong>Generate</strong>{" "}
          to use the resulting heatmap to guide generation.
        </p>
        <p>
          Interface scale, frame zoom, and panel auto-collapse options are under{" "}
          <strong>Interface</strong> in the settings drawer; workspace view options
          are under <strong>View</strong> in the panel.
        </p>
        <div className="gz-modal__row">
          <Toggle
            label="Show on startup"
            checked={showWelcome}
            onChange={(v) => set("showWelcome", v)}
          />
          <Button onClick={() => set("showWelcome", false)}>Close</Button>
        </div>
      </div>
    </div>
  );
}
