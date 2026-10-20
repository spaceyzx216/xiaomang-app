import { deleteDraft } from "../_lib/draftStore.js";
import { json } from "../_lib/common.js";
import { requireAuth } from "../_lib/auth.js";

export default async function handler(req: any, res: any) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (req.method !== "DELETE") {
    return json(res, 405, { success: false, error: "Method not allowed" });
  }

  const id = String(req.query?.id || "").trim();
  if (!id) {
    return json(res, 400, { success: false, error: "id is required" });
  }

  const removed = deleteDraft(id, user.id) ? 1 : 0;
  return json(res, 200, { success: true, removed });
}
