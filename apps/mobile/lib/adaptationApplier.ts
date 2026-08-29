import type { AdaptationProposal } from "./api";

// The FIXED applier script (docs/THIRD_PARTY_ADAPTATION.md §5) — "the hands". Never
// LLM-generated: it only knows how to turn already-validated vocabulary values into CSS. It
// has no idea what site it's running on and never needs to. injectedJavaScript/injectJavaScript
// must evaluate to a value react-native-webview can serialize — ending in `true;` is required
// on Android, otherwise the WebView can crash silently.
//
// A MutationObserver keeps re-asserting the style tag's presence (not its content — the CSS
// selectors already match new nodes on their own) in case a site's own script removes
// injected <style> tags on route changes (common in SPAs that reset <head> partially).
function buildLayerACss(p: AdaptationProposal): string {
  const lineSpacing = { normal: "1.5", relaxed: "1.8", loose: "2.2" }[p.line_spacing];
  const letterSpacing = { normal: "normal", wide: "0.05em" }[p.letter_spacing];
  const contrastFilter =
    p.contrast_mode === "high" ? "contrast(1.35) saturate(1.1)" : p.contrast_mode === "dark" ? "invert(1) hue-rotate(180deg)" : "none";

  return `
    /* zoom, not font-size%: an arbitrary third-party site is never guaranteed to size its
       text in em/rem (most don't — fixed px is extremely common), and font-size% only
       rescales relative units. zoom rescales the actual rendered pixels regardless of how
       the site authored its CSS, so it's the one approach that stays site-agnostic. */
    html { zoom: ${p.font_scale} !important; }
    /* universal selector, not an enumerated tag list: we can't know whether a given site's
       text lives in <p>/<span> or in <div>/<td>/custom elements, so guessing tags silently
       misses whatever the site actually used. */
    * {
      line-height: ${lineSpacing} !important;
      letter-spacing: ${letterSpacing} !important;
    }
    html { filter: ${contrastFilter} !important; }
    ${
      p.reduce_motion
        ? "*, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; scroll-behavior: auto !important; }"
        : ""
    }
    ${
      p.touch_target_boost
        ? // Same site-agnostic principle: match on semantics (real interactive tags, ARIA
          // interactive roles, an onclick handler) rather than assuming a site only builds
          // clickable controls out of <button>/<a>.
          "a, button, input, select, textarea, summary, label, [role='button'], [role='link'], [role='checkbox'], [role='radio'], [role='tab'], [role='menuitem'], [onclick] { min-height: 44px !important; min-width: 44px !important; padding: 8px !important; }"
        : ""
    }
  `.trim();
}

export function buildApplierScript(proposal: AdaptationProposal): string {
  const css = buildLayerACss(proposal);
  // JSON.stringify the CSS string so it's safely embeddable regardless of quotes/newlines
  // inside it — this script is built in React Native and shipped as a plain string into
  // injectJavaScript, there's no bundler escaping it for us.
  const cssLiteral = JSON.stringify(css);

  return `
    (function () {
      var STYLE_ID = "navi-adaptation";

      function applyStyle() {
        var existing = document.getElementById(STYLE_ID);
        if (existing) existing.remove();
        var style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = ${cssLiteral};
        document.head.appendChild(style);
      }

      applyStyle();

      if (!window.__naviObserver) {
        window.__naviObserver = new MutationObserver(function () {
          if (!document.getElementById(STYLE_ID)) applyStyle();
        });
        window.__naviObserver.observe(document.documentElement, { childList: true, subtree: true });
      }
    })();
    true;
  `;
}
