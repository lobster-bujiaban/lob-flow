from __future__ import annotations

from collections import defaultdict, deque

from lob_flow.models import DraftDefinition, WorkflowDefinition, WorkflowEdge, WorkflowNode


class WorkflowValidationError(ValueError):
    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


def default_workflow(draft: DraftDefinition) -> WorkflowDefinition:
    return WorkflowDefinition(
        nodes=[
            WorkflowNode(id="start", type="start", name="开始"),
            WorkflowNode(
                id="template",
                type="template",
                name="Prompt 模板",
                config={"template": draft.user_prompt_template},
            ),
            WorkflowNode(
                id="llm",
                type="llm",
                name="LLM",
                config={
                    "system_prompt": draft.system_prompt,
                    "provider_config_id": draft.model.provider_config_id,
                    "model": draft.model.model,
                    "temperature": draft.model.temperature,
                    "max_tokens": min(draft.model.max_tokens, 512),
                    "timeout_seconds": draft.model.timeout_seconds,
                },
            ),
            WorkflowNode(id="answer", type="answer", name="回答"),
        ],
        edges=[
            WorkflowEdge(source="start", target="template"),
            WorkflowEdge(source="template", target="llm"),
            WorkflowEdge(source="llm", target="answer"),
        ],
    )


def validate_and_sort(definition: WorkflowDefinition) -> list[WorkflowNode]:
    errors: list[str] = []
    node_by_id = {node.id: node for node in definition.nodes}
    if len(node_by_id) != len(definition.nodes):
        errors.append("节点 ID 必须唯一")
    starts = [node for node in definition.nodes if node.type == "start"]
    answers = [node for node in definition.nodes if node.type == "answer"]
    if len(starts) != 1:
        errors.append("工作流必须且只能包含一个 Start 节点")
    if not answers:
        errors.append("工作流至少需要一个 Answer 节点")

    outgoing: dict[str, list[str]] = defaultdict(list)
    indegree = {node.id: 0 for node in definition.nodes}
    for edge in definition.edges:
        if edge.source not in node_by_id or edge.target not in node_by_id:
            errors.append(f"连线引用不存在节点：{edge.source} → {edge.target}")
            continue
        outgoing[edge.source].append(edge.target)
        indegree[edge.target] += 1

    for node in definition.nodes:
        if node.type == "template" and not node.config.get("template"):
            errors.append(f"Template 节点 {node.id} 缺少 template")
        if node.type == "llm":
            for key in ("provider_config_id", "model"):
                if not node.config.get(key):
                    errors.append(f"LLM 节点 {node.id} 缺少 {key}")
    if errors:
        raise WorkflowValidationError(errors)

    queue = deque(node_id for node_id, degree in indegree.items() if degree == 0)
    ordered: list[str] = []
    while queue:
        node_id = queue.popleft()
        ordered.append(node_id)
        for target in outgoing[node_id]:
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)
    if len(ordered) != len(definition.nodes):
        raise WorkflowValidationError(["工作流存在循环依赖"])

    reachable: set[str] = set()
    queue = deque([starts[0].id])
    while queue:
        node_id = queue.popleft()
        if node_id in reachable:
            continue
        reachable.add(node_id)
        queue.extend(outgoing[node_id])
    unreachable = sorted(set(node_by_id) - reachable)
    if unreachable:
        raise WorkflowValidationError([f"存在不可达节点：{', '.join(unreachable)}"])
    if ordered[0] != starts[0].id:
        raise WorkflowValidationError(["Start 节点必须是唯一入口"])
    return [node_by_id[node_id] for node_id in ordered]
