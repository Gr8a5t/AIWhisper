/**
 * MongoDB-backed authentication state for Baileys.
 * Replaces useMultiFileAuthState so WhatsApp credentials survive
 * server restarts (Render's ephemeral filesystem wipes the whatsapp-auth dir).
 */
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { getDb } from './mongodb';

export async function useMongoAuthState() {
  const db = await getDb();
  const col = db.collection('whatsapp_auth');

  const readData = async (id: string): Promise<any> => {
    const doc = await col.findOne({ _id: id as any });
    if (!doc || !doc.data) return null;
    return JSON.parse(JSON.stringify(doc.data), BufferJSON.reviver);
  };

  const writeData = async (id: string, data: any): Promise<void> => {
    const serialized = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
    await col.updateOne(
      { _id: id as any },
      { $set: { data: serialized, updatedAt: new Date() } },
      { upsert: true }
    );
  };

  const removeData = async (id: string): Promise<void> => {
    await col.deleteOne({ _id: id as any });
  };

  // Load existing creds or create fresh ones
  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const data: Record<string, any> = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data: Record<string, Record<string, any>>) => {
          const tasks: Promise<void>[] = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const docId = `${category}-${id}`;
              tasks.push(value ? writeData(docId, value) : removeData(docId));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData('creds', creds),
  };
}

/** Wipes all WhatsApp auth data from MongoDB (used during logout). */
export async function clearMongoAuthState(): Promise<void> {
  const db = await getDb();
  await db.collection('whatsapp_auth').deleteMany({});
}
