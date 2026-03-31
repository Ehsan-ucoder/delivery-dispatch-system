export const JOB_ASSIGN_ORDER = "assign-order";
export const JOB_ASSIGNMENT_TIMEOUT = "assignment-timeout";
export const JOB_CHARGE_ORDER = "charge-order";

export type AssignOrderPayload = { orderId: string };
export type AssignmentTimeoutPayload = { assignmentId: string; orderId: string };
export type ChargeOrderPayload = { orderId: string };
