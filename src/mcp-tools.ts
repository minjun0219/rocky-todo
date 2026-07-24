import { z } from 'zod';

/**
 * rocky-todo 의 MCP 도구 스펙 단일 출처 — name / description / zod inputSchema.
 *
 * stdio 브릿지(mcp-stdio.ts)가 이 스펙에 REST 포워딩 핸들러를 바인딩한다.
 * 스펙과 핸들러를 분리해 도구 표면이 한 곳에서만 정의되게 한다.
 */

const actorSchema = z
  .string()
  .optional()
  .describe('who is acting (e.g. claude-code / codex / opencode); recorded in history');

export const linkSchema = z.object({ url: z.string(), title: z.string().optional() });

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
}

export const TODO_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'todo_list',
    description:
      '공유 todo 보드 조회. board 로 보드 하나, 생략 시 전체. id 를 주면 해당 todo 상세 + 히스토리, boards:true 면 보드 목록. 필터: status / label / includeArchived.',
    inputSchema: {
      board: z.string().optional().describe('board key (usually the repo name)'),
      id: z.string().optional().describe('todo id (or unique prefix) for detail + history'),
      boards: z.boolean().optional().describe('true → list boards instead of todos'),
      status: z.enum(['todo', 'doing', 'done']).optional(),
      label: z.string().optional(),
      includeArchived: z.boolean().optional(),
    },
  },
  {
    name: 'todo_write',
    description:
      'todo 생성/수정. id 없으면 생성(board + title 필수), 있으면 부분 수정. section 은 이름으로 자동 upsert. links 에 GitHub 이슈 / Todoist URL 을 첨부해 맥락을 연결한다. 삭제는 없다 — todo_status 의 archive 를 쓴다.',
    inputSchema: {
      id: z.string().optional().describe('omit to create, set to patch an existing todo'),
      board: z.string().optional().describe('board key — required when creating'),
      title: z.string().optional().describe('required when creating'),
      description: z.string().optional().describe('markdown detail'),
      section: z.string().optional().describe('section name (upserted within the board)'),
      parentId: z.string().optional().describe('parent todo id for hierarchy'),
      priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
      due: z.string().optional().describe('ISO date, e.g. 2026-08-01'),
      labels: z.array(z.string()).optional(),
      links: z.array(linkSchema).optional(),
      actor: actorSchema,
    },
  },
  {
    name: 'todo_status',
    description:
      'todo 상태 전이. start=처리 시작(누가 작업중인지 웹 UI 에 표시됨 — 작업 착수 시 반드시 호출), stop=중단, done=완료, reopen=재오픈, archive/unarchive=보관/복원.',
    inputSchema: {
      id: z.string().describe('todo id (or unique prefix)'),
      action: z.enum(['start', 'stop', 'done', 'reopen', 'archive', 'unarchive']),
      actor: actorSchema,
    },
  },
  {
    name: 'note_list',
    description:
      '스크래치패드/메모 조회. board 로 보드 소속, global:true 로 보드 미소속 메모. id 를 주면 상세 + 히스토리.',
    inputSchema: {
      board: z.string().optional(),
      global: z.boolean().optional(),
      id: z.string().optional(),
      includeArchived: z.boolean().optional(),
    },
  },
  {
    name: 'note_write',
    description:
      '스크래치패드/메모 작성. id 없으면 생성(title 필수), 있으면 수정. mode: set=content 교체(기본) / append=뒤에 이어붙임 / archive=보관 / unarchive=복원. 삭제는 없다.',
    inputSchema: {
      id: z.string().optional(),
      board: z.string().optional().describe('omit for a global note'),
      title: z.string().optional(),
      content: z.string().optional(),
      mode: z.enum(['set', 'append', 'archive', 'unarchive']).optional(),
      actor: actorSchema,
    },
  },
];
