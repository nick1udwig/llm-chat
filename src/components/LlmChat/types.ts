export type MessageContent = {
  type: 'text';
  text: string;
} | {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
} | {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
};

export type Message = {
  role: 'user' | 'assistant';
  content: MessageContent[] | string;
  timestamp: Date;
  toolInput?: Record<string, unknown>;
};

export type ConversationSettings = {
  apiKey: string;
  model: string;
  systemPrompt: string;
  tools: Tool[];
  mcpServers: McpServer[];
};

export type Conversation = {
  id: string;
  name: string;
  messages: Message[];
  settings: ConversationSettings;
};

export type Tool = {
  name: string;
  description: string;
  input_schema: object;
};
