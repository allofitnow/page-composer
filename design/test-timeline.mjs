// The frame maths behind the trim timeline, exercised without a browser.
//
// This is the part that is silently wrong rather than loudly broken: an in
// point one frame off still encodes, still plays, and nobody notices until the
// clip is on the site. So every conversion between frames, seconds and pixels
// is pinned here, at the rates that actually turn up — 23.976, 24, 25, 29.97,
// 30, 50, 59.94, 60.
import {
  frameOf,
  seekTime,
  edgeTime,
  spanSeconds,
  timecode,
  clampView,
  zoomView,
  frameToX,
  xToFrame,
  tickStep,
  MIN_SPAN,
} from '../web/timeline.js';

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  );
};
const near = (label, got, want, tol = 1e-9) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}` + (ok ? '' : `\n        got ${got} want ${want}`));
};

const RATES = [24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60];

// 1. Round tripping. Seek to a frame, ask which frame that is, get the same
//    number back — at every rate, across the whole clip. This is the property
//    the entire feature rests on.
let worst = null;
for (const fps of RATES) {
  for (let f = 0; f < 4000; f++) {
    if (frameOf(seekTime(f, fps), fps) !== f) {
      worst = { fps, f, got: frameOf(seekTime(f, fps), fps) };
      break;
    }
  }
  if (worst) break;
}
check('a seek lands on the frame it was asked for, at every rate', worst, null);

// 2. The frame's own presentation time must map to itself too — that is what
//    requestVideoFrameCallback hands back, and it sits exactly ON the boundary
//    where float error bites.
let edge = null;
for (const fps of RATES) {
  for (let f = 0; f < 4000; f++) {
    if (frameOf(edgeTime(f, fps), fps) !== f) {
      edge = { fps, f, t: edgeTime(f, fps), got: frameOf(edgeTime(f, fps), fps) };
      break;
    }
  }
  if (edge) break;
}
check('a frame boundary maps to that frame, not the one before', edge, null);

// The specific case that motivates the epsilon: 4/25 is not representable.
near('25fps frame 4 sits at 0.16', edgeTime(4, 25), 0.16, 1e-12);
check('...and reads back as frame 4', frameOf(0.16000000000000003, 25), 4);
check('...even from just under it', frameOf(0.15999999999999998, 25), 4);

// 2b. The platform truncates. requestVideoFrameCallback in WebView2 reports
//     mediaTime to about six decimals, so frame 1001 at 60fps arrives as
//     16.683333 rather than 16.68333333... — 2e-5 of a frame short. These are
//     values measured from the running app, not invented: with a 1e-6 epsilon
//     the first of them read as frame 1000, and stepping one frame back landed
//     two frames back.
check('a truncated mediaTime still names its own frame', frameOf(16.683333, 60), 1001);
check('...and the frame after it', frameOf(16.7, 60), 1002);
check('...and one further down the clip', frameOf(34.566667, 60), 2074);
check('a 25fps truncation', frameOf(0.079999, 25), 2);
// The epsilon must stay far below half a frame or it would swallow real
// positions: a time genuinely in the middle of a frame must not round up.
check('the epsilon cannot reach the next frame', frameOf(edgeTime(5, 25) + 0.5 / 25, 25), 5);
check('nor the one before', frameOf(edgeTime(5, 25) - 0.5 / 25, 25), 4);

// 3. Mid-frame is where a seek should aim: as far from both edges as possible.
near('a seek aims at the middle of the frame', seekTime(10, 25), 10.5 / 25);
check('a negative frame is clamped, not seeked to', seekTime(-5, 25) > 0, true);

// 4. The span handed to ffmpeg. Both marks are INCLUSIVE, so a 2..5 trim keeps
//    FOUR frames. ffmpeg keeps a frame when its PTS is >= ss and < ss+t, so the
//    numbers aim half a frame PAST each boundary rather than at it: on the
//    boundary, the last decimal printed decides whether a frame is in or out.
//    Measured against real ffmpeg — a 31-frame trim expressed as boundaries
//    came back 32 frames long.
near('the in point sits half a frame before the in frame', spanSeconds(2, 5, 25).in, 1.5 / 25);
near('the out point sits half a frame after the out frame', spanSeconds(2, 5, 25).out, 5.5 / 25);
near('the span is still exactly four frames', spanSeconds(2, 5, 25).out - spanSeconds(2, 5, 25).in, 4 / 25);
near('a single-frame trim is exactly one frame', spanSeconds(7, 7, 30).out - spanSeconds(7, 7, 30).in, 1 / 30);
check('marks given backwards are sorted, not rejected', spanSeconds(9, 3, 25), spanSeconds(3, 9, 25));

// The margin has to be a real gap on both sides, or the rounding can tip it.
for (const fps of RATES) {
  const s = spanSeconds(10, 20, fps);
  const headroom = Math.min(10 / fps - s.in, s.out - 20 / fps);
  near(`half a frame of margin either side at ${fps.toFixed(3)}fps`, headroom, 0.5 / fps, 1e-12);
}

// Frame 0 has nowhere to put the head margin, so it clamps — and the tail
// margin is what keeps that end safe.
check('a trim from frame 0 starts at 0', spanSeconds(0, 9, 25).in, 0);
near('...and still runs to half a frame past the out frame', spanSeconds(0, 9, 25).out, 9.5 / 25);

// The number of frames a span asks for, which is what ffprobe -count_frames
// will report. Rounding here is the whole ballgame.
for (const fps of RATES) {
  for (const [a, b] of [[0, 0], [0, 9], [5, 5], [100, 130], [2076, 2106]]) {
    const s = spanSeconds(a, b, fps);
    const frames = Math.round((s.out - s.in) * fps);
    if (frames !== b - a + 1) {
      check(`span ${a}..${b} at ${fps} is ${b - a + 1} frames`, frames, b - a + 1);
    }
  }
}
check('every span asks for exactly its own frame count', true, true);

// 5. Timecode. Non-drop, so 29.97 labels at 30 — a label, not a timecode track.
check('timecode counts frames within the second', timecode(0, 25), '00:00:00:00');
check('the last frame of the first second', timecode(24, 25), '00:00:00:24');
check('and the first of the next', timecode(25, 25), '00:00:01:00');
check('minutes roll over', timecode(25 * 61, 25), '00:01:01:00');
check('hours roll over', timecode(25 * 3661, 25), '01:01:01:00');
check('29.97 is labelled as 30', timecode(30, 30000 / 1001), '00:00:01:00');

// 6. The view. Zooming must not escape the clip or collapse past MIN_SPAN.
check('a view cannot be narrower than MIN_SPAN', clampView({ start: 10, end: 11 }, 500).end - clampView({ start: 10, end: 11 }, 500).start, MIN_SPAN);
check('a view cannot start before the clip', clampView({ start: -40, end: 60 }, 500).start, 0);
check('a view cannot end past the clip', clampView({ start: 480, end: 620 }, 500), { start: 360, end: 500 });
check('a clip shorter than MIN_SPAN still gets a usable view', clampView({ start: 0, end: 1 }, 1), { start: 0, end: MIN_SPAN });

// Zoom keeps the frame under the cursor under the cursor — that is what makes
// wheel-zoom feel like a map rather than a slider.
const v0 = { start: 0, end: 1000 };
const zoomed = zoomView(v0, 1000, 250, 0.5);
near('zoom holds the focus frame in place', (250 - zoomed.start) / (zoomed.end - zoomed.start), 0.25, 1e-9);
check('zooming in halves the span', zoomed.end - zoomed.start, 500);
check('zooming out past the clip just fits it', zoomView({ start: 100, end: 200 }, 1000, 150, 100), { start: 0, end: 1000 });
check('zooming in stops at MIN_SPAN', zoomView({ start: 0, end: 1000 }, 1000, 500, 0.0001).end - zoomView({ start: 0, end: 1000 }, 1000, 500, 0.0001).start, MIN_SPAN);

// 7. Pixels. The ruler is only frame accurate if x -> frame -> x survives.
const view = { start: 100, end: 400 };
near('frame to pixel at the left edge', frameToX(100, view, 900), 0);
near('frame to pixel at the right edge', frameToX(400, view, 900), 900);
near('and back again', xToFrame(frameToX(237, view, 900), view, 900), 237, 1e-9);
check('a click inside a frame floors to that frame', Math.floor(xToFrame(frameToX(237, view, 900) + 1, view, 900)), 237);

// 8. Tick spacing. Ticks must never be closer than the minimum, and at full
//    zoom they must be per-frame or the ruler is lying about accuracy.
check('a wide-open view does not tick every frame', tickStep({ start: 0, end: 30000 }, 900, 25) > 1, true);
check('a fully zoomed view ticks every frame', tickStep({ start: 0, end: 10 }, 900, 25), 1);
let tooTight = null;
for (const fps of RATES) {
  for (const span of [4, 10, 50, 200, 1000, 5000, 50000]) {
    const step = tickStep({ start: 0, end: span }, 900, fps);
    if ((step / span) * 900 < 8 - 1e-9) tooTight = { fps, span, step };
  }
}
check('no tick spacing falls below the minimum', tooTight, null);

console.log(failures ? `\n${failures} FAILED` : '\nall timeline checks passed');
process.exit(failures ? 1 : 0);
