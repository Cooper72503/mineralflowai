import FinderWorkspace from "../FinderWorkspace";
export default function FinderRunPage({ params }: { params: { runId: string } }) { return <FinderWorkspace runId={params.runId} />; }
