from __future__ import annotations

from collections import defaultdict, deque
import re

from lob_flow.models import DraftDefinition, WorkflowDefinition, WorkflowEdge, WorkflowNode


class WorkflowValidationError(ValueError):
    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


def default_workflow(draft: DraftDefinition) -> WorkflowDefinition:
    return WorkflowDefinition(nodes=[], edges=[])


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
        if node.type == "start":
            variables = node.config.get("variables", [])
            names: set[str] = set()
            for variable in variables:
                name = str(variable.get("name", ""))
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                    errors.append(f"开始节点变量名无效：{name or '空'}")
                elif name in names:
                    errors.append(f"开始节点变量名重复：{name}")
                names.add(name)
                if variable.get("type") not in ("string", "number", "boolean"):
                    errors.append(f"开始节点变量 {name} 类型无效")
        if node.type == "template" and not node.config.get("template"):
            errors.append(f"Template 节点 {node.id} 缺少 template")
        if node.type == "llm":
            for key in ("provider_config_id", "model"):
                if not node.config.get(key):
                    errors.append(f"LLM 节点 {node.id} 缺少 {key}")
        if node.type == "tool":
            for key in ("plugin_id", "tool_name"):
                if not node.config.get(key):
                    errors.append(f"Tool 节点 {node.id} 缺少 {key}")
            if node.config.get("runtime") == "dify" and not node.config.get("provider_name"):
                errors.append(f"Dify Tool 节点 {node.id} 缺少 provider_name")
        if node.type == "knowledge":
            if not node.config.get("dataset_id"):
                errors.append(f"Knowledge 节点 {node.id} 缺少 dataset_id")
            if node.config.get("search_method", "hybrid_search") not in ("keyword_search", "vector_search", "hybrid_search"):
                errors.append(f"Knowledge 节点 {node.id} 检索方式无效")
            if not 0 <= float(node.config.get("vector_weight", 0.7)) <= 1:
                errors.append(f"Knowledge 节点 {node.id} 向量权重必须在 0 到 1 之间")
        if node.type == "condition":
            if not node.config.get("left"):
                errors.append(f"条件节点 {node.id} 缺少判断变量")
            if node.config.get("operator") not in ("equals", "not_equals", "contains", "not_contains", "greater_than", "less_than", "is_empty", "is_not_empty"):
                errors.append(f"条件节点 {node.id} 运算符无效")
            handles = {edge.source_handle for edge in definition.edges if edge.source == node.id}
            if not {"true", "false"}.issubset(handles):
                errors.append(f"条件节点 {node.id} 必须连接 TRUE 和 FALSE 两个分支")
        if node.type == "switch":
            if not node.config.get("expression"):
                errors.append(f"SWITCH 节点 {node.id} 缺少判断变量")
            cases = node.config.get("cases", [])
            case_ids = [str(item.get("id", "")) for item in cases]
            case_values = [str(item.get("value", "")) for item in cases]
            if not cases:
                errors.append(f"SWITCH 节点 {node.id} 至少需要一个 Case")
            if any(not re.fullmatch(r"case_[A-Za-z0-9_-]+", case_id) for case_id in case_ids):
                errors.append(f"SWITCH 节点 {node.id} 存在无效 Case ID")
            if len(set(case_ids)) != len(case_ids) or len(set(case_values)) != len(case_values):
                errors.append(f"SWITCH 节点 {node.id} 的 Case ID 和匹配值必须唯一")
            handles = {edge.source_handle for edge in definition.edges if edge.source == node.id}
            missing = [case_id for case_id in [*case_ids, "default"] if case_id not in handles]
            if missing:
                errors.append(f"SWITCH 节点 {node.id} 存在未连线分支：{', '.join(missing)}")
        if node.type == "answer":
            outputs = node.config.get("outputs", [])
            names: set[str] = set()
            for output in outputs:
                name = str(output.get("name", ""))
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                    errors.append(f"回答节点输出字段名无效：{name or '空'}")
                elif name in names:
                    errors.append(f"回答节点输出字段名重复：{name}")
                names.add(name)
                if output.get("type") not in ("string", "number", "boolean", "object"):
                    errors.append(f"回答节点输出 {name} 类型无效")
                if not output.get("value"):
                    errors.append(f"回答节点输出 {name} 缺少变量映射")
    for edge in definition.edges:
        source = node_by_id.get(edge.source)
        if source and source.type == "condition" and edge.source_handle not in ("true", "false"):
            errors.append(f"条件节点 {edge.source} 的连线缺少分支端口")
        if source and source.type == "switch":
            valid_handles = {str(item.get("id")) for item in source.config.get("cases", [])} | {"default"}
            if edge.source_handle not in valid_handles:
                errors.append(f"SWITCH 节点 {edge.source} 的分支端口无效")
        if source and edge.source_handle == "error" and source.type not in ("llm", "tool", "knowledge"):
            errors.append(f"节点 {edge.source} 不支持 ERROR 分支")
        if source and source.type not in ("condition", "switch") and edge.source_handle is not None:
            if edge.source_handle != "error":
                errors.append(f"普通节点 {edge.source} 不能使用分支端口")
    output_schemas = [
        [(str(item.get("name")), str(item.get("type"))) for item in node.config.get("outputs", [])]
        for node in answers if node.config.get("outputs")
    ]
    if output_schemas and any(schema != output_schemas[0] for schema in output_schemas[1:]):
        errors.append("多个回答节点的结构化输出字段和类型必须一致")
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
