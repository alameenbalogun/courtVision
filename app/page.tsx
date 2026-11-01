import Link from 'next/link';
import { MatchList } from '@/components/MatchList';

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Live video workflow</span>
          <h1>Record the match. Replay the point. Question the bounce.</h1>
          <p className="lead">
            CourtVision turns an ordinary phone into a tennis recording and review tool: continuous local
            recording, a rolling replay window, frame-accurate review, and court calibration that puts every
            bounce on a measured court plane.
          </p>
          <div className="hero-actions">
            <Link href="/record" className="btn btn--primary">
              Start a live session
            </Link>
            <a href="#how" className="btn btn--ghost">
              How the pipeline works
            </a>
          </div>
          <p className="small muted">
            Works in the browser — no app store account needed. Camera capture requires HTTPS (or localhost),
            and footage never leaves the device unless you export it.
          </p>
        </div>

        <aside className="hero-panel">
          <h2>Session shape</h2>
          <ol className="steps">
            <li className="step">
              <span className="step-num">1</span>
              <div>
                <strong>Set up.</strong>{' '}
                <span className="muted">
                  Grant camera access, frame the whole court, choose resolution and buffer length.
                </span>
              </div>
            </li>
            <li className="step">
              <span className="step-num">2</span>
              <div>
                <strong>Start match.</strong>{' '}
                <span className="muted">
                  Video is written locally while a rolling window keeps the last 10–20 seconds ready.
                </span>
              </div>
            </li>
            <li className="step">
              <span className="step-num">3</span>
              <div>
                <strong>Save the point.</strong>{' '}
                <span className="muted">
                  One tap keeps the previous seconds as a replay clip, with timestamps intact.
                </span>
              </div>
            </li>
            <li className="step">
              <span className="step-num">4</span>
              <div>
                <strong>Review and calibrate.</strong>{' '}
                <span className="muted">
                  Scrub, slow down, step frames, mark court keypoints, export clips.
                </span>
              </div>
            </li>
            <li className="step">
              <span className="step-num">5</span>
              <div>
                <strong>Optional AI pass.</strong>{' '}
                <span className="muted">
                  A separate best-effort analysis proposes bounce candidates — IN, OUT, or UNCERTAIN.
                </span>
              </div>
            </li>
          </ol>
        </aside>
      </section>

      <div className="notice notice--warn">
        <p>
          <strong>Line calls are experimental estimates, not official decisions.</strong> A single fixed
          camera cannot resolve every bounce: the ball is above the court plane, and footage is often blurred
          or occluded. The system is designed to answer <span className="mono">UNCERTAIN</span> whenever the
          evidence does not support a confident call.
        </p>
      </div>

      <section className="section">
        <div className="section-head">
          <h2>Local sessions</h2>
          <Link href="/record" className="btn btn--sm btn--primary">
            New session
          </Link>
        </div>
        <MatchList />
      </section>

      <section className="section" id="how">
        <div className="section-head">
          <h2>How it works</h2>
        </div>
        <div className="grid grid--3">
          <article className="card">
            <h3>Recording is independent</h3>
            <p className="small muted" style={{ marginTop: 8 }}>
              The camera and recorder run on their own path. Analysis is a best-effort job over sampled
              frames, so a failed or slow analysis can never stop or corrupt the recording.
            </p>
          </article>
          <article className="card">
            <h3>Local first</h3>
            <p className="small muted" style={{ marginTop: 8 }}>
              Clips are stored in this browser&apos;s IndexedDB. Nothing is uploaded; exports are explicit
              downloads. Deleting a session removes its local footage.
            </p>
          </article>
          <article className="card">
            <h3>Timestamps stay aligned</h3>
            <p className="small muted" style={{ marginTop: 8 }}>
              Replay clips keep a match offset and the analysis stores per-event millisecond timestamps, so a
              review can always return to the exact recorded moment.
            </p>
          </article>
          <article className="card">
            <h3>Court plane, not guesswork</h3>
            <p className="small muted" style={{ marginTop: 8 }}>
              You mark court keypoints; a homography maps the frame onto a metric court. Bounce distances are
              reported in metres with an uncertainty band.
            </p>
          </article>
          <article className="card">
            <h3>Abstention is a feature</h3>
            <p className="small muted" style={{ marginTop: 8 }}>
              If the estimated bounce lies within twice its uncertainty of a line, the answer is{' '}
              <span className="mono">UNCERTAIN</span>, with the evidence frames that produced it.
            </p>
          </article>
          <article className="card">
            <h3>Built for hot phones</h3>
            <p className="small muted" style={{ marginTop: 8 }}>
              Low-power mode records 720p and shortens the replay window. Sustained 1080p recording plus
              analysis will heat mid-range devices — test your own phone before a real match.
            </p>
          </article>
        </div>
      </section>
    </>
  );
}
