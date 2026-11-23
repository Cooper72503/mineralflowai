import FinderWorkspace from "../../FinderWorkspace";
export default function ProspectPage({ params }: { params: { runId: string; api: string } }) { return <FinderWorkspace runId={params.runId} api={params.api} />; }
