"""현재 대화·작업 표의 정제와 수식 결과를 같은 형식으로 제공한다."""
from services.formula.schemas import FormulaJob
from services.operations.jobs import operation_history_context


def same_formula_workspace(job, conversation_id: str, workspace: dict | None) -> bool:
    if not isinstance(job, FormulaJob) or str(job.source.conversation_id) != conversation_id:
        return False
    if workspace is None:
        return job.source.workspace_id is None
    return (str(job.source.workspace_id) == str(workspace['workspace_id'])
            and job.source.worksheet_id == workspace['worksheet_id']
            and job.source.table_id == str(workspace['table_id'])
            and job.source.workspace_task_type == workspace['task_type'])


def execution_history_context(operation_jobs: dict, formula_jobs: dict, *, conversation_id: str, workspace) -> dict:
    history = operation_history_context(operation_jobs, conversation_id=conversation_id, workspace=workspace)
    if not workspace:
        return history
    columns = {str(column['column_id']): column for column in workspace['columns']}

    def column_info(column_id):
        column = columns.get(column_id)
        return {'column_id': column_id, 'current_header': column['header'] if column else None,
                'exists': column is not None}

    records = list(history['records'])
    for job in formula_jobs.values():
        if not same_formula_workspace(job, conversation_id, workspace):
            continue
        plan = job.preview.plan if job.preview else None
        settings = plan.model_dump_json() if plan else ''
        results = []
        for column_id in job.result.result_column_ids if job.result else ():
            column = column_info(column_id)
            results.append({**column, 'purpose': 'data', 'can_continue': job.status == 'APPLIED' and column['exists']})
        records.append({
            'job_id': str(job.source.formula_job_id), 'created_at': job.created_at.isoformat(),
            'status': job.status, 'kind': 'formula', 'instruction': job.source.instruction,
            'input_columns': [column_info(column.column_id) for column in job.source.input_columns],
            'settings_excerpt': settings[:1600], 'settings_truncated': len(settings) > 1600,
            'output_name': ', '.join(action.output_label for action in plan.actions) if plan else None,
            'result_columns': results,
            'executed_range': {'first_excel_row': job.source.row_start + 1, 'row_count': job.source.row_count},
        })
    records.sort(key=lambda record: record['created_at'], reverse=True)
    # shortcut: 최근 8건만 제공한다. 오래된 작업 검색은 별도 조회 단계가 필요하다.
    return {'records': records[:8], 'omitted_count': history['omitted_count'] + max(0, len(records) - 8)}
