import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { queryOf, wrap } from '../middleware/validate.js';
import { forbidden } from '../errors.js';

export const router = Router();

const listQuery = z.object({
  scope: z.enum(['mine', 'all']).default('mine'),
  channel: z.enum(['email', 'sms']).optional(),
  status: z.enum(['queued', 'retrying', 'sent', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** The simulated inbox. Customers see their own messages; staff may view the whole outbox (scope=all). */
router.get(
  '/',
  authenticate,
  queryOf(listQuery),
  wrap(async (req, res) => {
    const { scope, channel, status, limit } = req.query;
    const isStaff = ['staff', 'manager', 'admin'].includes(req.user.role);
    if (scope === 'all' && !isStaff) throw forbidden();
    const params = [];
    const where = [];
    if (scope === 'mine' || !isStaff) {
      params.push(req.user.id);
      where.push(`n.user_id = $${params.length}`);
    }
    if (channel) {
      params.push(channel);
      where.push(`n.channel = $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`n.status = $${params.length}`);
    }
    params.push(limit);
    const { rows } = await query(
      `SELECT n.*, u.full_name AS recipient_name
         FROM notifications n LEFT JOIN users u ON u.id = n.user_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY n.created_at DESC LIMIT $${params.length}`,
      params,
    );
    res.json({
      notifications: rows.map((n) => ({
        id: n.id,
        channel: n.channel,
        to: n.to_addr,
        subject: n.subject,
        body: n.body,
        kind: n.kind,
        bookingId: n.booking_id,
        recipientName: n.recipient_name,
        createdAt: n.created_at,
        // ID-44, ID-47: delivery result after up to 3 attempts
        status: n.status,
        attempts: n.attempts,
        error: n.status === 'failed' ? n.last_error : null,
        deliveredAt: n.delivered_at,
        attachment: n.attachment_name,
        receiptId: n.receipt_id,
      })),
    });
  }),
);
