import type { Metadata } from 'next';
import { MatchReview } from '@/components/MatchReview';

export const metadata: Metadata = {
  title: 'Match review — CourtVision',
};

export default async function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MatchReview matchId={id} />;
}
