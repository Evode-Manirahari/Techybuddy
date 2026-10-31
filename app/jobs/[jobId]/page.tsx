import { Workspace } from "../../../src/components/workspace";

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return <Workspace jobId={jobId} />;
}
