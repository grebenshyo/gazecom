import { useStore } from "../store";
import { compositeStore } from "./CompositeStore";

export async function downloadComposite(): Promise<void> {
  const state = useStore.getState();
  if (!state.compositeHasCanvas) return;

  const blob = await compositeStore.toBlob({
    matteColor: state.compositeMatteEnabled ? state.matteColor : undefined,
  });
  if (!blob) return;
  const href = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = href;
  a.download = state.isComposited
    ? `composite_${Date.now()}.png`
    : `output_${Date.now()}.png`;
  a.click();

  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
