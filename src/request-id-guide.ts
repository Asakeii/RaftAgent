/** Upgrade only known legacy guidance; retain custom paragraphs and explicit recovery IDs. */
export function migrateRequestIdGuide(text: string): string {
  return text
    .replace(/ --request-id (?:UNIQUE_ID|NEW_ID|create-reviewer-001|followup-001|publish-count-001|remove-count-001)\b/g, '')
    .replace('所有写命令需要一个新的稳定 request-id。一次操作的重试必须复用原 ID 和原内容；通信失败先', 'requestId 由 CLI 自动分配，不需要自行填写。发送前的 request.started 与返回回执包含原 ID；通信失败先')
    .replace('查询，不生成新 ID 重发。', '查询。每次重新调用 CLI 默认是新操作；仅确定重试同一幂等操作时用 --request-id ORIGINAL_ID 和原内容。not_found 不证明未执行，脚本不能自动重跑。')
    .replace('创建和后续委派都要固定 request-id，重试同一命令复用原 ID 和参数。', '创建和后续委派由 CLI 自动分配 requestId；通信失败先按回执 ID 查询，确认重试时才显式复用原 ID 和参数。')
    .replace('修改草稿，用**新的** request-id 再次 publish；', '修改草稿后再次 publish，CLI 为本次新操作自动分配 requestId；')
    .replace('草稿变更是新操作，使用新 request-id。', '草稿变更是新操作，由 CLI 自动分配新的 requestId。')
    .replace('`--based-on` 与 `--request-id` 不可省略。', '`--based-on` 不可省略；requestId 由 CLI 自动分配。')
    .replace('request-id 可省略，由 CLI 生成；结果不确定时按返回 ID 重试。', 'request-id 由 CLI 自动生成；结果不确定时先按回执 ID 查询，确认重试时显式复用该 ID，不能省略后重跑。');
}
