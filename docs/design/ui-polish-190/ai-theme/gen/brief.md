# Task: generate 6 theme assets with the built-in image_gen tool

You are generating trial art for a desktop-app theme preview ("AI 酱" / AI Buddy). The user approved exactly 6 images.

Rules (follow strictly):
- Use ONLY the built-in `image_gen` tool (the imagegen skill's default built-in mode). Do NOT use `scripts/image_gen.py`, the CLI fallback, any API key, or any other image service.
- Exactly one `image_gen` call per asset below, 6 calls total. If one fails, do not retry; report the failure.
- After each image is generated, copy the output file from `$CODEX_HOME/generated_images/...` into `./out/` in this working directory, using the exact filename given (PNG). Keep transparency (alpha) for the two-word "-orn" assets.
- Do not create, modify or delete any other files, and do not run any other commands besides the copies (and listing `./out` at the end).
- At the end, reply with: each output path, the exact prompt you sent for it, and whether the "-orn" outputs are transparent.

Shared constraints for all six: no text, no letters, no logo, no watermark, no signature, no frame, no border, no characters/people. No ocean waves or wave crests. No corner-bracket ornaments. No repeating border bands.

---

## 1. out/deepseek-bg.png
Use case: stylized-concept
Asset type: background for the main content area of a dark desktop app; UI cards and text sit on top, so it must stay quiet
Primary request: a deep-sea atmosphere seen from below the surface
Scene/backdrop: deep ocean, very dark navy blue (#0A1220 at the bottom to #111D33 near the top)
Details: a few soft, faint shafts of light coming down from the top; a sparse scattering of small translucent bubbles; nothing else
Style/medium: soft painterly digital illustration, low detail
Composition/framing: landscape 3:2, no focal subject, darker toward the bottom and edges, generous empty dark space
Color palette: navy #0A1220, #111D33, very small hints of azure #5B9BFF and white
Constraints: very low contrast overall; no fish, no creatures, no waves, no seabed objects, no text, no watermark

## 2. out/deepseek-orn.png
Use case: stylized-concept
Asset type: small UI ornament, transparent PNG, pinned to the top edge of a card in a dark navy theme
Primary request: one elegant white maid-uniform ribbon bow with delicate lace edging and a small deep-navy knot in the center
Style/medium: clean anime-style illustration, crisp edges, soft shading
Composition/framing: front view, centered, single bow only, wide shape about 2:1, small margins
Color palette: apron white #F3F6FB with soft blue-grey shading, navy #1A2A44 knot
Constraints: transparent background, single object, no drop shadow on the background, no text

## 3. out/grok-bg.png
Use case: stylized-concept
Asset type: background for the main content area of a dark gothic-lolita desktop app theme; UI cards and text sit on top
Primary request: near-black velvet backdrop with one faint gold-line thorned rose vine
Scene/backdrop: deep near-black velvet (#110D10 to #1A1417) with a very slight warm crimson tint in the lower right
Details: a single delicate gold line-art rose vine with thorns grows up from the lower-right corner and fades out; the rest of the canvas stays empty dark velvet
Style/medium: elegant gothic illustration, fine gilded line work, painterly velvet texture
Composition/framing: landscape 3:2, the vine occupies only the lower-right fifth; most of the canvas is empty
Color palette: #110D10, #1A1417, antique gold #CFA95C at low intensity, crimson #C8324D only as a faint tint
Constraints: low contrast; not a tiled or repeating damask pattern; no frame, no corner brackets, no text, no watermark

## 4. out/grok-orn.png
Use case: stylized-concept
Asset type: horizontal ornamental divider, transparent PNG, placed under a heading in a dark gothic theme
Primary request: one crimson rose bloom at the left end, with a slender gilded-gold thorned stem extending horizontally to the right, two small gold leaves along the stem, the stem tapering to a fine point
Style/medium: refined gothic jewelry illustration, gilded metal look, crisp edges
Composition/framing: very wide horizontal composition (the ornament spans almost the full width, thin in height), centered vertically, single object
Color palette: crimson #C8324D rose, antique gold #CFA95C stem and leaves
Constraints: transparent background, no shadow on the background, no text, no frame

## 5. out/qwen-bg.png
Use case: stylized-concept
Asset type: background for the main content area of a light "blue-and-white porcelain" desktop app theme; UI cards and text sit on top
Primary request: porcelain-white glaze surface with one faint cobalt lotus-scroll motif in a lower corner
Scene/backdrop: soft off-white porcelain glaze (#F3F6FA) with very subtle crackle-free sheen
Details: a single faint cobalt-blue lotus scroll (traditional Chinese blue-and-white porcelain painting) in the lower-left corner only, fading out; the rest stays plain glaze
Style/medium: traditional Chinese blue-and-white porcelain brush painting, soft and pale
Composition/framing: landscape 3:2, motif occupies only the lower-left corner area, large empty space everywhere else
Color palette: #F3F6FA base, cobalt #2A49AE at low intensity
Constraints: very low contrast; no border bands, no frame, no repeating pattern, no vase shape, no text, no seal stamp, no watermark

## 6. out/qwen-orn.png
Use case: stylized-concept
Asset type: small UI ornament, transparent PNG, centered on the top edge of a card in a light porcelain theme
Primary request: one ruyi cloud-head motif (traditional Chinese auspicious cloud, symmetric left-right with curled ends) painted in cobalt blue on white porcelain, blue-and-white porcelain style
Style/medium: traditional blue-and-white porcelain brush painting, clean edges
Composition/framing: front view, centered, single motif, wide shape about 5:2
Color palette: cobalt #2A49AE with lighter blue washes, white porcelain fill
Constraints: transparent background outside the motif, no text, no seal stamp, no frame
