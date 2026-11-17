import type { TaskNode } from "./model";

export type AccessContext = {
  userId: string;
  memberId: string;
  role: "manager" | "executor" | "viewer";
  displayName: string;
};

export function canManage(viewer: AccessContext): boolean {
  return viewer.role === "manager";
}

export function canSubmit(viewer: AccessContext, node: TaskNode): boolean {
  return canManage(viewer) || (viewer.role === "executor" &&
    (node.ownerId === viewer.memberId || node.participants.includes(viewer.memberId)));
}

/** A direct task channel is accessible only to its executor and the manager. */
export function canReadChannel(viewer: AccessContext, channel: string | null): boolean {
  return channel === null || canManage(viewer) || (viewer.role === "executor" && viewer.memberId === channel);
}

export function canWriteChannel(viewer: AccessContext, channel: string | null): boolean {
  return viewer.role !== "viewer" && canReadChannel(viewer, channel);
}
