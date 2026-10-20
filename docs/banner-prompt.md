# Banner image prompt

Use this to generate `docs/banner.png` (referenced at the top of the README).

- **Aspect ratio:** 4:1 (wide banner). Export at **1280×320** (or 2560×640 @2x).
- **Safe zone:** keep the title text and logos centered; leave ~8% padding so
  nothing is clipped by GitHub's rounded corners.

---

## Primary prompt (copy–paste)

```
A sleek, modern GitHub repository banner for an open-source developer tool named
"multi-ai-provider-gateway". Ultra-wide 4:1 horizontal composition on a deep
charcoal-to-midnight-blue gradient background (#0d1117 to #161b22), matching a
dark developer IDE theme.

Centerpiece: a glowing central "gateway" node — a clean hexagonal or diamond
API-hub glyph in cyan (#58a6ff). Two luminous data streams of flowing particles
converge into it from the left and right: the left stream tinted electric blue
(Kiro / Amazon Q), the right stream tinted emerald green (GitHub Copilot). Thin
circuit-trace lines and subtle JSON/curly-brace motifs woven into the
background. A faint network grid and soft bokeh light points add depth.

Style: minimal, premium, techy, flat-vector with soft neon glow and subtle
depth-of-field. High contrast, crisp edges, lots of negative space, no clutter.
Leave clear empty space in the horizontal center for an overlaid title. No text,
no words, no letters, no logos, no watermarks.

Color palette: charcoal #0d1117, slate #161b22, cyan #58a6ff, blue #1f6feb,
emerald #2ea043 / #7ee787, white highlights.
```

## Negative prompt (if your tool supports it)

```
text, words, letters, typography, logos, brand marks, watermark, signature,
people, faces, hands, clutter, busy background, low-res, jpeg artifacts,
photorealistic photography, 3D render noise, cartoon mascot
```

## Tool-specific tips

- **Midjourney:** append ` --ar 4:1 --style raw --v 6` and optionally ` --no text`.
- **DALL·E / ChatGPT:** ask for "a 1280×320 wide banner, dark theme, no text".
- **Ideogram:** great if you *do* want the title rendered — add
  `with the text "multi-ai-provider-gateway" in a clean modern monospace font,
  centered, white`.
- **Stable Diffusion (SDXL):** use the negative prompt above; sampler DPM++ 2M
  Karras, 30 steps, CFG 5–7; generate at 1024×256 then upscale 2×.

## Optional: title-overlaid variant

If you want the name baked into the image instead of overlaying it in the
README, add this to the primary prompt:

```
Centered title text "multi-ai-provider-gateway" in a crisp modern monospace /
geometric sans font, white with a soft cyan glow, with a small subtitle below in
muted gray: "one endpoint · Kiro + GitHub Copilot".
```

After generating, save the file as `docs/banner.png`.
