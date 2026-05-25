
import { getDb } from './mongodb';
import type { Conversation, Message, Agent, Stats, KnowledgeFile, LogEntry } from '@/types';

// NOTE: File-based JSON storage has been replaced with MongoDB Atlas so that
// data persists across Render restarts (ephemeral filesystem).

// --- Conversations ---

export async function getConversations(): Promise<Conversation[]> {
  const db = await getDb();
  return db.collection<Conversation>('conversations')
    .find({}, { projection: { _id: 0 } })
    .sort({ 'lastMessage.timestamp': -1 })
    .toArray();
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  const db = await getDb();
  const doc = await db.collection<Conversation>('conversations').findOne({ id }, { projection: { _id: 0 } });
  return doc ?? undefined;
}

export async function updateConversation(id: string, update: Partial<Omit<Conversation, 'id'>>) {
  const db = await getDb();
  const col = db.collection('conversations');
  const existing = await col.findOne({ id });

  if (existing) {
    await col.updateOne({ id }, { $set: update });
  } else {
    const newConvo: Conversation = {
      id,
      name: update.name || id.split('@')[0],
      unreadCount: update.unreadCount || 0,
      lastMessage: update.lastMessage || { text: '', timestamp: Date.now() },
      avatar:
        update.avatar ||
        `https://placehold.co/100x100.png?text=${(update.name || id.charAt(0)).toUpperCase()}`,
      ...update,
    };
    await col.insertOne(newConvo as any);
  }
}

// --- Messages ---

export async function getMessages(chatId: string): Promise<Message[]> {
  const db = await getDb();
  return db.collection<Message>('messages')
    .find({ chatId }, { projection: { _id: 0 } })
    .toArray();
}

export async function addMessage(message: Message) {
  const db = await getDb();
  // Avoid duplicate inserts (Baileys can deliver the same message twice)
  await db.collection('messages').updateOne(
    { id: message.id },
    { $setOnInsert: message },
    { upsert: true }
  );
}

// --- Stats ---

export async function getStats(): Promise<Stats> {
  const db = await getDb();
  const doc = await db.collection('stats').findOne({ _id: 'global' as any });
  const stats: Stats = {
    sent: doc?.sent || 0,
    received: doc?.received || 0,
    activeAgents: 0,
    errors: doc?.errors || 0,
  };
  const agents = await getAgents();
  stats.activeAgents = agents.filter((a) => a.status === 'active').length;
  return stats;
}

export async function incrementStat(key: 'sent' | 'received' | 'errors') {
  const db = await getDb();
  await db.collection('stats').updateOne(
    { _id: 'global' as any },
    { $inc: { [key]: 1 } },
    { upsert: true }
  );
}

// --- Agents ---

export async function getAgents(): Promise<Agent[]> {
  const db = await getDb();
  const agents = await db.collection<Agent>('agents')
    .find({}, { projection: { _id: 0 } })
    .toArray();
  // Backward-compat: default missing fields
  for (const a of agents) {
    if (!a.status) (a as any).status = 'active';
    if (!(a as any).mode) (a as any).mode = 'rule';
  }
  return agents;
}

export async function getAgent(id: string): Promise<Agent | undefined> {
  const db = await getDb();
  const doc = await db.collection<Agent>('agents').findOne({ id }, { projection: { _id: 0 } });
  return doc ?? undefined;
}

function normaliseAiSettings(settings: any) {
  return {
    provider: settings.provider || 'openai',
    apiKey: settings.apiKey || '',
    systemPrompt:
      settings.systemPrompt !== undefined && settings.systemPrompt !== null
        ? settings.systemPrompt
        : 'You are a helpful assistant.',
    maxLen: settings.maxLen || 500,
    temperature: settings.temperature || 0.7,
    knowledgeFileIds: Array.isArray(settings.knowledgeFileIds) ? settings.knowledgeFileIds : [],
  };
}

export async function updateAgent(id: string, update: Partial<Omit<Agent, 'id'>>) {
  const db = await getDb();

  if (update.mode === 'ai') {
    update.aiSettings = normaliseAiSettings(update.aiSettings || {});
  }

  await db.collection<Agent>('agents').updateOne({ id }, { $set: update });
}

export async function deleteAgent(id: string) {
  const db = await getDb();
  await db.collection<Agent>('agents').deleteOne({ id });
}

export async function addAgent(
  agent: Omit<Agent, 'id' | 'mode'> & Partial<Pick<Agent, 'mode'>>
) {
  const db = await getDb();

  if (agent.mode === 'ai') {
    agent.aiSettings = normaliseAiSettings(agent.aiSettings || {});
  }

  const newAgent: Agent = {
    id: `agent_${Date.now()}`,
    status: 'active',
    mode: agent.mode || 'rule',
    ...agent,
  };

  await db.collection<Agent>('agents').insertOne(newAgent as any);
  return newAgent;
}

// --- Conversation helpers ---

export async function setConversationAssignedAgent(chatId: string, agentId: string) {
  await updateConversation(chatId, { assignedAgentId: agentId });
}

// --- Knowledge Base ---

export async function getKnowledgeFiles(): Promise<KnowledgeFile[]> {
  const db = await getDb();
  return db.collection<KnowledgeFile>('knowledge')
    .find({}, { projection: { _id: 0 } })
    .toArray();
}

export async function getKnowledgeFile(id: string): Promise<KnowledgeFile | undefined> {
  const db = await getDb();
  const doc = await db.collection<KnowledgeFile>('knowledge').findOne({ id }, { projection: { _id: 0 } });
  return doc ?? undefined;
}

export async function addKnowledgeFile(
  fileData: Omit<KnowledgeFile, 'id' | 'createdAt'>
): Promise<KnowledgeFile> {
  const db = await getDb();
  const newFile: KnowledgeFile = {
    id: `file_${Date.now()}`,
    createdAt: Date.now(),
    ...fileData,
  };
  await db.collection<KnowledgeFile>('knowledge').insertOne(newFile as any);
  return newFile;
}

export async function deleteKnowledgeFile(id: string): Promise<void> {
  const db = await getDb();
  await db.collection<KnowledgeFile>('knowledge').deleteOne({ id });
}

// --- Logs ---

const MAX_LOGS = 100;

export async function getLogs(): Promise<LogEntry[]> {
  const db = await getDb();
  return db.collection<LogEntry>('logs')
    .find({}, { projection: { _id: 0 } })
    .sort({ timestamp: -1 })
    .limit(MAX_LOGS)
    .toArray();
}

export async function addLog(logData: Omit<LogEntry, 'id' | 'timestamp'>) {
  const db = await getDb();
  const col = db.collection('logs');

  const newLog: LogEntry = {
    id: `log_${Date.now()}`,
    timestamp: Date.now(),
    ...logData,
  };

  await col.insertOne(newLog as any);

  // Trim old logs beyond MAX_LOGS
  const count = await col.countDocuments();
  if (count > MAX_LOGS) {
    const toDelete = await col
      .find({}, { projection: { id: 1 } })
      .sort({ timestamp: 1 })
      .limit(count - MAX_LOGS)
      .toArray();
    const ids = toDelete.map((d: any) => d.id);
    await col.deleteMany({ id: { $in: ids } });
  }
}
