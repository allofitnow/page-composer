// A frame-accurate trim timeline.
//
// The unit here is the FRAME, not the second. Seconds are only produced at the
// two edges: seeking a <video> (which takes a time) and handing the cut to
// ffmpeg. Everything in between — markers, zoom, scrubbing, the readouts — is
// integer frames, because that is the only way the in point you set is the in
// point that gets encoded.
//
// The frame rate always comes from ffprobe on the SOURCE file, never from the
// proxy the overlay may actually be playing: the frame numbers have to mean the
// same thing to ffmpeg at compose time, and compose reads the source.

// ---------------------------------------------------------------- the maths

/**
 * Which frame is on screen at `time`.
 *
 * A frame N occupies [N/fps, (N+1)/fps), so this is a floor, not a round. The
 * epsilon — a thousandth of a frame, in FRAMES, after the multiply — absorbs
 * two different kinds of error:
 *
 *   - plain float: 4/25 is 0.16000000000000003 down one path and
 *     0.15999999999999998 down another, and a bare floor puts the second on
 *     frame 3;
 *   - truncation by the platform: requestVideoFrameCallback reports mediaTime
 *     rounded to about six decimals, so frame 1001 at 60fps arrives as
 *     16.683333 instead of 16.68333333…. That is 2e-5 of a frame short, which
 *     an epsilon of 1e-6 does not cover — measured in WebView2, and the reason
 *     stepping one frame back used to land two frames back.
 *
 * A thousandth of a frame is 16 microseconds at 60fps: far too small to
 * swallow a genuine position, far too large for either error to survive.
 */
export const FRAME_EPSILON = 1e-3;
export const frameOf = (time, fps) => Math.max(0, Math.floor(time * fps + FRAME_EPSILON));

/**
 * Where to seek to LAND on a frame — the middle of it, not its edge.
 *
 * Seeking to the exact boundary is a coin toss: the smallest float error either
 * side puts the decoder on the neighbouring frame. Half a frame in is as far
 * from both edges as it is possible to be.
 */
export const seekTime = (frame, fps) => (Math.max(0, frame) + 0.5) / fps;

/** The frame's true start, which is what ffmpeg wants. */
export const edgeTime = (frame, fps) => Math.max(0, frame) / fps;

/**
 * A frame span as the seconds ffmpeg needs.
 *
 * Both marks are INCLUSIVE — the out frame is kept, the way every NLE means it.
 *
 * The half-frame offsets are not decoration. ffmpeg keeps a frame when its PTS
 * is >= ss and < ss+t, so handing it the exact frame boundaries puts both ends
 * ON a decision point and the last decimal of the number decides whether a
 * frame is in or out. Measured: a 31-frame trim expressed as boundaries came
 * back 32 frames long, because 31/60 printed to three decimals is 0.517 and
 * frame 32 sits at 0.51667. Aiming half a frame past each boundary is as far
 * from both decisions as it is possible to be — the same reason a seek aims at
 * the middle of a frame rather than its edge.
 *
 * The in point clamps at zero, so a trim that starts on frame 0 keeps its
 * margin at the tail instead.
 */
export function spanSeconds(inFrame, outFrame, fps) {
  const a = Math.max(0, Math.min(inFrame, outFrame));
  const b = Math.max(inFrame, outFrame);
  return { in: Math.max(0, (a - 0.5) / fps), out: (b + 0.5) / fps };
}

/** Non-drop HH:MM:SS:FF. 29.97 is shown as 30 — a label, not a timecode track. */
export function timecode(frame, fps) {
  const r = Math.max(1, Math.round(fps));
  const f = Math.max(0, Math.round(frame));
  const secs = Math.floor(f / r);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(secs / 3600))}:${p(Math.floor(secs / 60) % 60)}:${p(secs % 60)}:${p(f % r)}`;
}

/** The narrowest the ruler is allowed to get, in frames. */
export const MIN_SPAN = 4;

/** Keeps a view inside the clip and no narrower than MIN_SPAN. */
export function clampView(view, total, minSpan = MIN_SPAN) {
  const max = Math.max(total, minSpan);
  const span = Math.min(Math.max(view.end - view.start, minSpan), max);
  const start = Math.min(Math.max(view.start, 0), max - span);
  return { start, end: start + span };
}

/**
 * Zoom by `factor` about `focusFrame`, keeping that frame under the cursor.
 * factor < 1 zooms in.
 */
export function zoomView(view, total, focusFrame, factor, minSpan = MIN_SPAN) {
  const span = view.end - view.start;
  if (span <= 0) return clampView(view, total, minSpan);
  const at = (focusFrame - view.start) / span; // 0..1 across the ruler
  const next = Math.min(Math.max(span * factor, minSpan), Math.max(total, minSpan));
  return clampView({ start: focusFrame - next * at, end: focusFrame - next * at + next }, total, minSpan);
}

export const frameToX = (frame, view, width) => ((frame - view.start) / (view.end - view.start)) * width;
export const xToFrame = (x, view, width) => view.start + (x / width) * (view.end - view.start);

/**
 * A tick interval that leaves at least `minPx` between ticks.
 *
 * The ladder is in frames but climbs through whole seconds once a per-frame
 * ruler would be unreadable, so the labels stay on round times.
 */
export function tickStep(view, width, fps, minPx = 8) {
  const span = Math.max(1e-6, view.end - view.start);
  const perFrame = width / span;
  if (perFrame >= minPx) return 1;
  const r = Math.max(1, Math.round(fps));
  const ladder = [1, 2, 5, 10, r, r * 2, r * 5, r * 10, r * 30, r * 60, r * 300, r * 600, r * 1800, r * 3600];
  for (const step of ladder) if (step * perFrame >= minPx) return step;
  return ladder[ladder.length - 1];
}

// ---------------------------------------------------------------- the widget

const el = (tag, cls, style) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (style) n.setAttribute('style', style);
  return n;
};

/**
 * Builds the timeline into `mount` and wires it to a <video>.
 *
 * `info` is what probeMedia returned: { fps, frames, duration, ... }.
 * `getTrim()` returns { inFrame, outFrame } or null; `onTrim(next)` stores it.
 */
export function createTimeline({ mount, video, info, getTrim, onTrim, onFrame }) {
  const fps = info.fps;
  const total = Math.max(1, info.frames);
  let view = { start: 0, end: total };
  let frame = 0;
  let dragging = null; // 'play' | 'in' | 'out'

  const ruler = el('canvas', 'tl__ruler');
  const layer = el('div', 'tl__layer');
  const inMark = el('div', 'tl__mark tl__mark--in');
  const outMark = el('div', 'tl__mark tl__mark--out');
  const keep = el('div', 'tl__keep');
  const head = el('div', 'tl__head');
  inMark.title = 'In point — drag, or press I';
  outMark.title = 'Out point — drag, or press O';
  layer.append(keep, inMark, outMark, head);

  const track = el('div', 'tl__track');
  track.append(ruler, layer);

  const readout = el('div', 'tl__read m');
  const bar = el('div', 'tl__bar');
  mount.replaceChildren(track, readout, bar);

  // ---- geometry ----------------------------------------------------------
  const width = () => track.clientWidth || 1;
  const toX = (f) => frameToX(f, view, width());
  const atX = (x) => Math.min(total - 1, Math.max(0, Math.floor(xToFrame(x, view, width()))));

  // ---- painting ----------------------------------------------------------
  function paintRuler() {
    const w = width();
    const h = 34;
    const dpr = window.devicePixelRatio || 1;
    ruler.width = Math.max(1, Math.round(w * dpr));
    ruler.height = Math.round(h * dpr);
    ruler.style.width = w + 'px';
    ruler.style.height = h + 'px';
    const g = ruler.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const step = tickStep(view, w, fps);
    const first = Math.ceil(view.start / step) * step;
    g.font = '9px ui-monospace, Consolas, monospace';
    g.textBaseline = 'top';

    for (let f = first; f <= view.end; f += step) {
      const x = Math.round(toX(f)) + 0.5;
      // A tick on a whole second is taller and labelled; the rest are hairlines.
      const onSecond = fps > 0 && Math.abs((f / fps) - Math.round(f / fps)) < 1e-6;
      g.strokeStyle = onSecond ? 'rgba(217,225,234,0.45)' : 'rgba(217,225,234,0.18)';
      g.beginPath();
      g.moveTo(x, h - (onSecond ? 12 : 6));
      g.lineTo(x, h);
      g.stroke();
      if (onSecond && step * (w / (view.end - view.start)) >= 34) {
        g.fillStyle = 'rgba(217,225,234,0.45)';
        g.fillText(timecode(f, fps), x + 3, 2);
      }
    }

    // At maximum zoom the individual frames are wide enough to shade, which is
    // the only honest way to show that a mark sits ON a frame, not between two.
    const perFrame = w / (view.end - view.start);
    if (perFrame >= 14) {
      for (let f = Math.floor(view.start); f <= view.end; f++) {
        if (f % 2) continue;
        g.fillStyle = 'rgba(217,225,234,0.05)';
        g.fillRect(toX(f), 0, perFrame, h);
      }
    }
  }

  function paintMarks() {
    const w = width();
    const t = getTrim();
    const a = t ? t.inFrame : 0;
    const b = t ? t.outFrame : total - 1;
    const inX = toX(a);
    const outX = toX(b + 1); // the mark sits on the far edge of the out FRAME
    keep.style.left = inX + 'px';
    keep.style.width = Math.max(0, outX - inX) + 'px';
    inMark.style.left = inX + 'px';
    outMark.style.left = outX + 'px';
    inMark.dataset.set = t ? '1' : '0';
    outMark.dataset.set = t ? '1' : '0';
    head.style.left = toX(frame) + 'px';
    head.style.width = Math.max(1, w / (view.end - view.start)) + 'px';

    const kept = b - a + 1;
    readout.textContent =
      `${timecode(frame, fps)}  ·  F${frame}` +
      `     IN ${timecode(a, fps)}  OUT ${timecode(b, fps)}` +
      `     KEEPS ${kept} FRAMES (${(kept / fps).toFixed(2)}S) OF ${total}` +
      `     ${fps.toFixed(3)} FPS`;
  }

  const paint = () => {
    paintRuler();
    paintMarks();
  };

  // ---- seeking -----------------------------------------------------------
  function goTo(f) {
    frame = Math.min(total - 1, Math.max(0, Math.round(f)));
    video.currentTime = seekTime(frame, fps);
    paintMarks();
    onFrame?.(frame);
  }

  /** Keeps the playhead visible when it walks out of a zoomed view. */
  function follow() {
    if (frame >= view.start && frame <= view.end) return;
    const span = view.end - view.start;
    view = clampView({ start: frame - span / 2, end: frame + span / 2 }, total);
    paint();
  }

  // ---- input -------------------------------------------------------------
  const localX = (e) => e.clientX - track.getBoundingClientRect().left;

  const startDrag = (what) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = what;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    move(e);
  };

  function move(e) {
    if (!dragging) return;
    const f = atX(localX(e));
    const t = getTrim() || { inFrame: 0, outFrame: total - 1 };
    if (dragging === 'in') {
      onTrim({ inFrame: Math.min(f, t.outFrame), outFrame: t.outFrame });
    } else if (dragging === 'out') {
      onTrim({ inFrame: t.inFrame, outFrame: Math.max(f, t.inFrame) });
    }
    // The picture follows the mark being dragged — setting an in point blind
    // is the whole reason numeric-only trimming is miserable.
    goTo(f);
    paintMarks();
  }

  const stop = () => {
    dragging = null;
  };

  track.addEventListener('pointerdown', startDrag('play'));
  inMark.addEventListener('pointerdown', startDrag('in'));
  outMark.addEventListener('pointerdown', startDrag('out'));
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);

  track.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const at = Math.floor(xToFrame(localX(e), view, width()));
      if (e.shiftKey) {
        // Shift is pan, so a trackpad can move along a zoomed clip.
        const span = view.end - view.start;
        view = clampView({ start: view.start + (e.deltaY / 400) * span, end: view.end + (e.deltaY / 400) * span }, total);
      } else {
        view = zoomView(view, total, at, e.deltaY > 0 ? 1.25 : 0.8);
      }
      paint();
    },
    { passive: false }
  );

  // ---- buttons -----------------------------------------------------------
  const button = (label, title, fn) => {
    const b = el('button', 'chip');
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      fn();
    });
    return b;
  };

  const zoomTo = (a, b) => {
    const pad = Math.max(2, Math.round((b - a) * 0.25));
    view = clampView({ start: a - pad, end: b + pad }, total);
    paint();
  };

  const api = {
    /** Called from the overlay's key handler and by the video's frame callback. */
    setFrame(f) {
      frame = Math.min(total - 1, Math.max(0, Math.round(f)));
      follow();
      paintMarks();
    },
    goTo,
    step(delta) {
      goTo(frame + delta);
      follow();
    },
    markIn() {
      const t = getTrim() || { inFrame: 0, outFrame: total - 1 };
      onTrim({ inFrame: frame, outFrame: Math.max(frame, t.outFrame) });
      paintMarks();
    },
    markOut() {
      const t = getTrim() || { inFrame: 0, outFrame: total - 1 };
      onTrim({ inFrame: Math.min(frame, t.inFrame), outFrame: frame });
      paintMarks();
    },
    clear() {
      onTrim(null);
      paintMarks();
    },
    zoomToIn() {
      const t = getTrim();
      const f = t ? t.inFrame : 0;
      zoomTo(f - 12, f + 12);
    },
    zoomToOut() {
      const t = getTrim();
      const f = t ? t.outFrame : total - 1;
      zoomTo(f - 12, f + 12);
    },
    fit() {
      view = { start: 0, end: total };
      paint();
    },
    repaint: paint,
    frame: () => frame,
    destroy() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      ro.disconnect();
    },
  };

  bar.append(
    button('◀ FRAME', 'One frame back  (←, shift for 10)', () => api.step(-1)),
    button('FRAME ▶', 'One frame on  (→, shift for 10)', () => api.step(1)),
    button('SET IN  I', 'In point at the playhead', () => api.markIn()),
    button('SET OUT  O', 'Out point at the playhead', () => api.markOut()),
    button('⤢ IN', 'Zoom to the in point', () => api.zoomToIn()),
    button('⤢ OUT', 'Zoom to the out point', () => api.zoomToOut()),
    button('FIT', 'The whole clip  (F)', () => api.fit()),
    button('CLEAR', 'Drop the trim', () => api.clear())
  );

  const ro = new ResizeObserver(() => paint());
  ro.observe(track);
  paint();
  return api;
}
