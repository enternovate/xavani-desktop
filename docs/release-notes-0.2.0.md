# Xavani Desktop v0.2.0 — Full parity + first-run setup + settings + voice

Shipped together with **xavani-agent v0.2.0** ("The Big Bang"). The desktop app now
surfaces every capability the 0.2.0 engine ships.

## Highlights

- **CLI 0.2.0 parity** — composer autocomplete lists all 90 engine commands (was 13).
  Session slash-commands run through the live Console; an Agent Ops view covers the rest.
- **First-run setup wizard** — new installs with no prior sessions get guided setup:
  provider + API key, model, toolsets, history import from Claude Code / Codex /
  Hermes / Cursor, and workspace root. Existing users never see it.
- **Full Settings view** — appearance/skins, model & provider, reasoning effort and
  fast mode, toolsets, MCP servers (add/remove), profiles, display zoom, updates,
  about. Whitelisted config editor only; comments in config.yaml preserved.
- **Effort + Fast mode chips** — topbar: provider · model · Effort · Fast on the left,
  same chip size, Preview stays right. Persists to `agent.reasoning_effort` and
  `agent.service_tier` — the same keys the CLI writes.
- **Update checker** — checks GitHub Releases hourly-ish (6 h interval), shows a badge,
  never auto-downloads or phones home.
- **Media visual edit** — click images and inline SVG in the preview dock:
  rotate / flip / grayscale / blur / brightness (canvas re-encode with .bak backup),
  SVG fill/stroke editing, changes handed to the agent as exact source instructions.
- **Voice input** — mic button in the composer; recording transcribed by the model
  (OpenAI `gpt-4o-transcribe` or Groq `whisper-large-v3` from your existing keys);
  transcript lands in the input for review before sending.
- **Fixes** — migration import no longer crashes (`MIG_LABELS` NameError); global error
  surfacing via toasts.

## Downloads

- macOS (Apple Silicon): `Xavani-0.2.0-macos-arm64.dmg`
- Windows x64: `Xavani-0.2.0-windows-x64-setup.exe` + portable zip

Both builds bundle the **xavani-agent v0.2.0** engine.
