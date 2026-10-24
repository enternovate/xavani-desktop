# Xavani Browser Extension

The Xavani browser extension connects your browser to the Xavani agent.
It is a Chrome/Edge/Chromium MV3 side panel that streams page context,
drafts text beside composers, and drives leased tabs through explicit
approval gates.

## How it works

1. The extension talks to the Xavani gateway API server on your machine
   (default `http://127.0.0.1:8642`).
2. Start the gateway with `xavani gateway-up`, then open the extension
   side panel and pick Local gateway.
3. Page context flows to your agent session. Remote gateway connections
   use the same ticketed WebSocket path as local.

## Security model

- Consequential or privileged tab actions pass an approval gate first.
- Control binds to one controller, one tab lease, and one document
  generation; leases never outlive the panel.
- Browser context stays redacted, labeled untrusted, and visible before
  it is sent.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked and select this repo's `extension/` folder.

## Attribution

Derivative of an MIT-licensed upstream browser extension. Required
copyright and permission notices are preserved upstream and in this
repository's history. Built by Enternovate under the MIT License.
