import { addDraft, clearDrafts, listDrafts } from "../_lib/draftStore.js";
import { json, readBody } from "../_lib/common.js";
import { requireAuth } from "../_lib/auth.js";

export default async function handler(req: any, res: any) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (req.method === "GET") {
    return json(res, 200, {
      success: true,
      items: listDrafts(user.id, {
        customerId: String(req.query?.customerId || "").trim(),
        taskId: String(req.query?.taskId || "").trim(),
      }),
    });
  }

  if (req.method === "POST") {
    const body = readBody(req);
    const item = addDraft(body && typeof body === "object" ? body : {}, user.id);
    return json(res, 200, { success: true, item });
  }

  if (req.method === "DELETE") {
    const removed = clearDrafts(user.id);
    return json(res, 200, { success: true, removed });
  }

  return json(res, 405, { success: false, error: "Method not allowed" });
}
