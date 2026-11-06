// 担当者の登録と、通知待ちの問い合わせを Deno KV に保存する。

import type { MessageRecord } from "./notify.ts";

export interface Staff {
  userId: string;
  displayName: string;
  registeredAt: string;
}

export class Store {
  constructor(private kv: Deno.Kv) {}

  static async open(path?: string): Promise<Store> {
    return new Store(await Deno.openKv(path));
  }

  // ---- 担当者 ----
  async addStaff(staff: Staff): Promise<void> {
    await this.kv.set(["staff", staff.userId], staff);
  }

  async removeStaff(userId: string): Promise<boolean> {
    const existing = await this.kv.get(["staff", userId]);
    if (!existing.value) return false;
    await this.kv.delete(["staff", userId]);
    return true;
  }

  async isStaff(userId: string): Promise<boolean> {
    return (await this.kv.get(["staff", userId])).value !== null;
  }

  async listStaff(): Promise<Staff[]> {
    const out: Staff[] = [];
    for await (const e of this.kv.list<Staff>({ prefix: ["staff"] })) out.push(e.value);
    return out;
  }

  // ---- 通知待ちの問い合わせ ----
  async addPending(id: string, record: MessageRecord): Promise<void> {
    // 30日経っても送れなかったものは自動で消える
    await this.kv.set(["pending", record.timestamp, id], record, { expireIn: 30 * 24 * 3600_000 });
  }

  async listPending(): Promise<{ key: Deno.KvKey; record: MessageRecord }[]> {
    const out: { key: Deno.KvKey; record: MessageRecord }[] = [];
    for await (const e of this.kv.list<MessageRecord>({ prefix: ["pending"] })) {
      out.push({ key: e.key, record: e.value });
    }
    return out;
  }

  async deleteKeys(keys: Deno.KvKey[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 10) {
      const op = this.kv.atomic();
      for (const k of keys.slice(i, i + 10)) op.delete(k);
      await op.commit();
    }
  }

  close(): void {
    this.kv.close();
  }
}
