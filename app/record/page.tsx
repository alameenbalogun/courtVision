import type { Metadata } from 'next';
import { LiveSession } from '@/components/LiveSession';

export const metadata: Metadata = {
  title: 'Live session — CourtVision',
  description: 'Record a tennis match locally with a rolling replay buffer.',
};

export default function RecordPage() {
  return (
    <>
      <div className="review-head">
        <div>
          <span className="eyebrow">Live session</span>
          <h1 style={{ marginTop: 4 }}>Record a match</h1>
          <p className="lead" style={{ marginTop: 8 }}>
            Keep the camera still behind one end of the court. Start the match, and tap{' '}
            <strong>Save replay</strong> whenever a point deserves a second look — the previous seconds are
            already buffered.
          </p>
        </div>
      </div>
      <LiveSession />
    </>
  );
}
