'use strict';

/* R2 Task 23 — renderer-side capture controls.

   Drives the Pack P state machine from the Capture bar. The state machine
   never grants OS permissions: the main-process adapter owns the display
   capture grant and the temporary file. This module only:
   - requests a source list (no capture, no prompt) for the picker,
   - starts capture after an explicit user gesture + source selection,
   - streams bounded chunks to main (which writes with backpressure),
   - pauses on pause AND while a secret-capable dialog is open,
   - stops all media tracks on every stop path,
   - saves via the native dialog or discards the temporary file. */

(function expose(root) {
  function createRecordingControls({ bridge, onState, onError }) {
    const { transitionRecording } = root.XavaniRecording;
    let state = 'idle';
    let media = null; // { recorder, stream, durationTimer }
    let dialogHold = false;

    function setState(event) {
      try {
        state = transitionRecording(state, event);
      } catch (err) {
        if (onError) onError(String(err && err.message ? err.message : err));
        return state;
      }
      if (onState) onState(state);
      return state;
    }

    function currentState() {
      return state;
    }

    async function listSources() {
      // A source list is not a capture and requests no permission.
      if (!bridge || !bridge.listSources) return [];
      return bridge.listSources();
    }

    async function start(sourceId) {
      if (state !== 'idle') return state;
      if (!sourceId) {
        if (onError) onError('Select a capture source first.');
        return state;
      }
      setState('request');
      try {
        if (!bridge || !bridge.startCapture) throw new Error('capture bridge unavailable');
        await bridge.startCapture(sourceId); // main pins the chosen source for the handler
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
        recorder.ondataavailable = (event) => {
          if (state !== 'recording') return; // pause stops byte production
          if (event.data && event.data.size) bridge.writeChunk(event.data.arrayBuffer());
        };
        recorder.onerror = () => { stopTracks(); setState('error'); };
        media = { recorder, stream, startedAt: Date.now() };
        recorder.start(1000);
        setState('granted');
        if (dialogHold) pause();
        // The limits are enforced by the main adapter (bytes + duration).
      } catch (err) {
        setState('denied');
        if (onError) onError(String(err && err.message ? err.message : err));
      }
      return state;
    }

    function pause() {
      if (state !== 'recording') return state;
      if (media && media.recorder.state === 'recording') media.recorder.pause();
      return setState('pause');
    }

    function resume() {
      if (state !== 'paused' || dialogHold) return state;
      if (media && media.recorder.state === 'paused') media.recorder.resume();
      return setState('resume');
    }

    function stopTracks() {
      if (!media) return;
      try { media.stream.getTracks().forEach((track) => track.stop()); } catch { /* already stopped */ }
    }

    function stop() {
      if (state !== 'recording' && state !== 'paused') return state;
      try { if (media && media.recorder.state !== 'inactive') media.recorder.stop(); } catch { /* noop */ }
      stopTracks();
      if (bridge && bridge.stopCapture) bridge.stopCapture();
      return setState('stop');
    }

    function limitReached() {
      if (state !== 'recording' && state !== 'paused') return state;
      try { if (media && media.recorder.state !== 'inactive') media.recorder.stop(); } catch { /* noop */ }
      stopTracks();
      if (bridge && bridge.stopCapture) bridge.stopCapture();
      return setState('limit');
    }

    async function save() {
      if (state !== 'stopped') return state;
      const result = await ((bridge && bridge.saveCapture) ? bridge.saveCapture() : null);
      if (result && result.canceled) {
        // Cancelled save retains the temporary recording for retry or discard.
        if (onError) onError('Save cancelled — the recording is kept for another save or a discard.');
        return state;
      }
      if (!result || result.error) {
        if (onError) onError(result && result.error ? result.error : 'Save failed.');
        return state;
      }
      return setState('save');
    }

    async function discard() {
      if (state !== 'stopped' && state !== 'failed' && state !== 'saved') return state;
      if (bridge && bridge.discardCapture) await bridge.discardCapture();
      if (state === 'saved') setState('reset');
      else setState('discard');
      return state;
    }

    function notifyDialog(open) {
      dialogHold = Boolean(open);
      if (dialogHold) pause();
      else if (state === 'paused') resume();
    }

    async function saveFromSaved() {
      if (state === 'saved') setState('reset');
      return save();
    }

    return { listSources, start, pause, resume, stop, limitReached, save, discard, notifyDialog, currentState };
  }

  const api = { createRecordingControls };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XavaniRecordingControls = api;
})(globalThis);
