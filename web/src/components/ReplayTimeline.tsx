// The bottom-bar timeline that fills the `data-replay-slot="timeline"` slot: a scrub track spanning the visible
// window with a playhead, plus window presets, transport, speed and a jump-to-time input. Scrubbing (or jumping)
// while live enters replay at that point; in replay the same gestures seek. Seeks during a drag are debounced
// 150 ms and committed on release, so a fast scrub does not rebuild the fold on every pointer move.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useReplay } from '../lib/replay';
import {
  clamp,
  inputValueToSimTime,
  JUMP_MS,
  positionPct,
  simTimeToInputValue,
  SPEED_OPTIONS,
  speedLabel,
  tFromFrac,
  WINDOW_PRESETS,
} from '../lib/replay-utils';

// Transport glyphs (inline SVG, currentColor) — the design system marks meaning with an icon, never colour alone.
const ico = { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' } as const;
const PlayIcon = () => (
  <svg {...ico}>
    <path d="M4 2.4v11.2L13.4 8 4 2.4z" fill="currentColor" />
  </svg>
);
const PauseIcon = () => (
  <svg {...ico}>
    <path d="M4 2.4h3v11.2H4zM9 2.4h3v11.2H9z" fill="currentColor" />
  </svg>
);
const StepBackIcon = () => (
  <svg {...ico}>
    <path d="M13 2.4v11.2L4.4 8 13 2.4zM2.6 2.4h1.6v11.2H2.6z" fill="currentColor" />
  </svg>
);
const StepFwdIcon = () => (
  <svg {...ico}>
    <path d="M3 2.4v11.2L11.6 8 3 2.4zM11.8 2.4h1.6v11.2h-1.6z" fill="currentColor" />
  </svg>
);

export function ReplayTimeline() {
  const { win, mode, playing, speed, presetMs, playhead, sessionId, setPresetMs, seek, enterReplay, togglePlay, step, setSpeed } =
    useReplay();

  const trackRef = useRef<HTMLDivElement>(null);
  const [dragT, setDragT] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const debounceRef = useRef<number | null>(null);
  // A scrub that began while live has to wait for enterReplay to create the session before it can seek.
  const pendingSeekRef = useRef<number | null>(null);

  const headT = dragT ?? playhead ?? win?.to ?? 0;
  const headPct = win ? positionPct(headT, win) : '0%';
  const transportDisabled = mode === 'live';

  useEffect(() => {
    if (sessionId && pendingSeekRef.current != null) {
      const at = pendingSeekRef.current;
      pendingSeekRef.current = null;
      seek(at);
    }
  }, [sessionId, seek]);

  useEffect(
    () => () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    },
    [],
  );

  const fracFrom = (clientX: number): number => {
    const el = trackRef.current;
    if (!el || !win) return 0;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return clamp((clientX - r.left) / r.width, 0, 1);
  };

  /** Seek now if replaying; otherwise remember it and seek the moment the session exists. */
  const commit = (atT: number) => {
    if (mode === 'replay') seek(atT);
    else pendingSeekRef.current = atT;
  };
  const scheduleSeek = (atT: number) => {
    if (mode !== 'replay') return;
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      seek(atT);
    }, 150);
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!win) return;
    trackRef.current?.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    const atT = tFromFrac(fracFrom(e.clientX), win);
    setDragT(atT);
    // Touching the track while live drops into replay at that instant.
    if (mode === 'live') void enterReplay(atT);
    else pendingSeekRef.current = null;
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || !win) return;
    const atT = tFromFrac(fracFrom(e.clientX), win);
    setDragT(atT);
    scheduleSeek(atT);
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (debounceRef.current != null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (win) commit(tFromFrac(fracFrom(e.clientX), win));
    setDragT(null);
  };

  // Jump-to-time mirrors the playhead unless the field has focus (so typing is not fought by cursor updates).
  const [jumpValue, setJumpValue] = useState('');
  const jumpFocus = useRef(false);
  useEffect(() => {
    if (!jumpFocus.current) setJumpValue(simTimeToInputValue(playhead));
  }, [playhead]);
  const onJump = (v: string) => {
    setJumpValue(v);
    if (!win) return;
    const ms = inputValueToSimTime(v);
    if (ms == null) return;
    const at = clamp(ms, win.from, win.to);
    if (mode === 'replay') seek(at);
    else void enterReplay(at);
  };

  const jump = (deltaMs: number) => {
    if (!win) return;
    const from = dragT ?? playhead ?? win.to;
    commit(clamp(from + deltaMs, win.from, win.to));
  };

  return (
    <>
      <div
        className="arl-replay__track"
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Replay position within the visible window"
        aria-valuemin={win ? Math.round(win.from) : 0}
        aria-valuemax={win ? Math.round(win.to) : 0}
        aria-valuenow={win ? Math.round(headT) : 0}
        aria-valuetext={simTimeToInputValue(headT).replace('T', ' ')}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {/* marker ticks are drawn here in STEP 3 */}
        <div className="arl-replay__head" style={{ left: headPct }} />
      </div>

      <div className="arl-replay__controls">
        <div className="arl-replay__group" role="group" aria-label="Window presets">
          {WINDOW_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className={`arl-replay__btn${presetMs === p.ms ? ' arl-replay__btn--on' : ''}`}
              aria-pressed={presetMs === p.ms}
              onClick={() => setPresetMs(p.ms)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="arl-replay__group" role="group" aria-label="Transport">
          <button
            type="button"
            className="arl-replay__btn arl-replay__icon"
            disabled={transportDisabled}
            title={transportDisabled ? 'Available in replay mode.' : 'Step to the previous message'}
            aria-label="Step back"
            onClick={() => step(-1)}
          >
            <StepBackIcon />
          </button>
          <button
            type="button"
            className="arl-replay__btn arl-replay__icon"
            disabled={transportDisabled}
            title={transportDisabled ? 'Available in replay mode.' : playing ? 'Pause' : 'Play'}
            aria-label={playing ? 'Pause' : 'Play'}
            onClick={togglePlay}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            type="button"
            className="arl-replay__btn arl-replay__icon"
            disabled={transportDisabled}
            title={transportDisabled ? 'Available in replay mode.' : 'Step to the next message'}
            aria-label="Step forward"
            onClick={() => step(1)}
          >
            <StepFwdIcon />
          </button>
          <button
            type="button"
            className="arl-replay__btn"
            disabled={transportDisabled}
            title={transportDisabled ? 'Available in replay mode.' : 'Jump back 5 minutes'}
            onClick={() => jump(-JUMP_MS)}
          >
            −5 min
          </button>
          <button
            type="button"
            className="arl-replay__btn"
            disabled={transportDisabled}
            title={transportDisabled ? 'Available in replay mode.' : 'Jump forward 5 minutes'}
            onClick={() => jump(JUMP_MS)}
          >
            +5 min
          </button>
        </div>

        <div className="arl-replay__group" role="group" aria-label="Playback speed">
          {SPEED_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={`arl-replay__btn${speed === s ? ' arl-replay__btn--on' : ''}`}
              disabled={transportDisabled}
              aria-pressed={speed === s}
              title={transportDisabled ? 'Available in replay mode.' : `Play at ${speedLabel(s)}`}
              onClick={() => setSpeed(s)}
            >
              {speedLabel(s)}
            </button>
          ))}
        </div>

        <div className="arl-replay__group arl-replay__jump">
          <label className="sr-only" htmlFor="replay-jump">
            Jump to sim time
          </label>
          <input
            id="replay-jump"
            className="arl-replay__time"
            type="datetime-local"
            step={1}
            value={jumpValue}
            min={win ? simTimeToInputValue(win.from) : undefined}
            max={win ? simTimeToInputValue(win.to) : undefined}
            disabled={!win}
            title="Jump to a sim time (Africa/Johannesburg)"
            onFocus={() => (jumpFocus.current = true)}
            onBlur={() => (jumpFocus.current = false)}
            onChange={(e) => onJump(e.target.value)}
          />
        </div>
      </div>
    </>
  );
}
