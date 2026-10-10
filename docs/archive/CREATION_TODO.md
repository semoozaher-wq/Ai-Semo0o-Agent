# Phase C — Semo0o Studio: AI Creation Platform (branch `feat/ai-video-creation`)

Baseline: `ebd4437` (Stable). Branch: `feat/ai-video-creation`. Rule: never touch master; never break the 669-test baseline.

## North star
One goal → Semo0o thinks → plans → executes → evaluates → improves → delivers the best possible result,
with minimal human intervention. Video creation is the first vertical, but the architecture is a general
**AI Creation platform** (Creation Kernel + Director + Providers + Studio API/UI).

## Architecture
- **Creation Kernel** (`backend/media/*`): deterministic, dependency-free media engine.
  PNG codec (node:zlib), RGBA raster compositor + bitmap font, animated GIF (LZW), RIFF/AVI (MJPEG+PCM),
  PCM audio DSP + procedural music, Timeline IR, deterministic Renderer. Optional ffmpeg acceleration.
- **Creation Intelligence** (`backend/creation/*`): Brief → Storyboard → PromptSmith → Produce → Critic → Improve → Compose → Deliver.
  Creation-aware model router, style/character bibles for consistency, multi-signal critic, bounded improvement loop.
- **Providers** (`backend/creation/providers.mjs`): pluggable image / image-to-video / text-to-video / TTS / music / vision-critic,
  reusing `connectors.mjs`; plus a deterministic **Local Studio** provider so the pipeline always produces a real deliverable.
- **Integration**: new tools in catalog+registry, `/creation/*` server routes, composition bundle (ZIP + HTML5 player), tests.

## Tasks
### Kernel
- [x] media/random.mjs — seeded PRNG (FNV-1a + mulberry32) + color helpers
- [x] media/png.mjs — PNG encode/decode (node:zlib), filters, RGBA
- [x] media/font.mjs — scalable 5x7 bitmap font (Latin/digits/punct) + measurement
- [x] media/raster.mjs — RGBA canvas: fill/gradient/blit(scale,alpha)/rounded rect/vignette/text/transitions
- [x] media/gif.mjs — animated GIF89a encoder (median-cut quantize + LZW + delay/loop) — validated by Pillow
- [x] media/jpeg.mjs — baseline JPEG encoder (DCT + Huffman, 4:2:0/4:4:4/grayscale) — validated by Pillow
- [x] media/avi.mjs — RIFF/AVI writer (MJPEG video + PCM audio), real playable container — validated by ffmpeg
- [x] media/audio.mjs — PCM mix/gain/fade/duck/normalize/resample + procedural music/SFX
- [x] media/timeline.mjs — versioned Timeline IR + validation + normalization
- [x] media/render.mjs — Timeline → frames+audio → GIF/AVI/PNG-seq + manifest (deterministic, seeded)
### Creation Intelligence
- [ ] creation/brief.mjs — one goal → structured CreativeBrief (LLM + deterministic fallback)
- [ ] creation/storyboard.mjs — Scene/Shot schema, normalize/validate, deterministic fallback storyboard
- [ ] creation/bibles.mjs — style bible + character bible (continuity anchors)
- [ ] creation/promptsmith.mjs — provider-ready prompt compilation (style/character/negative/camera)
- [ ] creation/critic.mjs — deterministic + LLM + vision scoring → score + revision directives
- [ ] creation/local-studio.mjs — deterministic production engine (motion graphics, Ken Burns, captions, music)
- [ ] creation/providers.mjs — CreationProvider abstraction (image/i2v/t2v/tts/music/critic) + capability probe
- [ ] creation/director.mjs — autonomous loop (plan/execute/evaluate/improve/deliver), budgets, events, artifacts
- [ ] creation/bundle.mjs — composition bundle (ZIP: timeline + assets + HTML5 player + manifest) via jszip
- [ ] creation/index.mjs — public API
### Integration
- [ ] agent/catalog.mjs — creation/studio tool definitions
- [ ] tools/registry.mjs — wire creation tools (honest status)
- [ ] server.mjs — /creation/* routes (start/status/storyboard/artifacts/render/iterate/deliver)
- [ ] frontend Studio screen + API client (web-first)
### Verification
- [ ] tests: media kernel (png/gif/avi/audio/timeline/render)
- [ ] tests: creation (brief/storyboard/promptsmith/critic/director/local-studio)
- [ ] tests: tools + server routes integration
- [ ] full baseline suite stays green (669 tests)
- [ ] end-to-end: one goal → real video artifact (GIF/AVI) + bundle, verified by probe
### Delivery
- [ ] CREATION_ARCHITECTURE.md + PHASE_C_REPORT.md
- [ ] ZIP of all changes (repo-matching paths)
- [ ] NO merge to master
