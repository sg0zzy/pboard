import type { CaptureRegion } from "../images/processing";

export function firstCaptureRegion(results: Array<{ result?: unknown }>): CaptureRegion | null {
  for (const { result } of results) {
    if (!result || typeof result !== "object") continue;
    const value = result as Partial<CaptureRegion>;
    if ([value.x, value.y, value.width, value.height, value.viewportWidth, value.viewportHeight]
      .every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
      return value as CaptureRegion;
    }
  }
  return null;
}

// This function is serialized by browser.scripting.executeScript. It must stay
// self-contained and must not refer to variables from this module.
export function selectPageRegion(): Promise<CaptureRegion | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    const selection = document.createElement("div");
    const hint = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(20,22,20,.10);user-select:none;touch-action:none";
    selection.style.cssText = "position:fixed;display:none;border:2px solid #fff;background:rgba(57,116,193,.16);box-shadow:0 0 0 1px #3974c1,0 2px 12px rgba(0,0,0,.28);pointer-events:none";
    hint.textContent = "Drag to capture · Esc to cancel";
    hint.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);border-radius:7px;background:#20211f;color:#fff;padding:8px 12px;font:600 13px system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3);pointer-events:none";
    overlay.append(selection, hint);
    document.documentElement.append(overlay);

    let startX = 0;
    let startY = 0;
    let dragging = false;
    let finished = false;

    const cleanup = () => {
      window.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
    };
    const finish = (region: CaptureRegion | null) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (!region) {
        resolve(null);
        return;
      }
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(region)));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    overlay.addEventListener("contextmenu", (event) => event.preventDefault());
    overlay.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      selection.style.display = "block";
      selection.style.left = `${startX}px`;
      selection.style.top = `${startY}px`;
      selection.style.width = "0";
      selection.style.height = "0";
      overlay.setPointerCapture(event.pointerId);
    });
    overlay.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const left = Math.min(startX, event.clientX);
      const top = Math.min(startY, event.clientY);
      selection.style.left = `${left}px`;
      selection.style.top = `${top}px`;
      selection.style.width = `${Math.abs(event.clientX - startX)}px`;
      selection.style.height = `${Math.abs(event.clientY - startY)}px`;
    });
    overlay.addEventListener("pointerup", (event) => {
      if (!dragging) return;
      dragging = false;
      const x = Math.min(startX, event.clientX);
      const y = Math.min(startY, event.clientY);
      const width = Math.abs(event.clientX - startX);
      const height = Math.abs(event.clientY - startY);
      if (width < 8 || height < 8) {
        finish(null);
        return;
      }
      finish({
        x,
        y,
        width,
        height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        href: location.href
      });
    });
    overlay.addEventListener("pointercancel", () => {
      if (!dragging) return;
      dragging = false;
      finish(null);
    });
  });
}
