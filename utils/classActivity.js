// What the class list shows for each class: the newest message and how many
// messages I have not read yet. Also builds the live "class:activity" payload.

const ClassMessage = require('../models/ClassMessage');
const { displayName } = require('./displayName');

const MAX_UNREAD = 100; // the app shows "99+" beyond this

const labelOf = (a) => {
  if (!a) return '';
  if (a.kind === 'image') return 'Photo';
  if (a.kind === 'audio') return 'Voice note';
  return a.name || 'File';
};

// From a message document (used when the class list is loaded)
const fromDoc = (m, userId) => {
  if (!m) return null;
  const att = m.attachment && m.attachment.url ? m.attachment : null;
  const senderId = String(m.sender && m.sender._id ? m.sender._id : m.sender);

  return {
    id:         String(m._id),
    senderId,
    senderName: displayName(m.sender),
    text:       m.deleted
      ? 'This message was deleted'
      : (m.text ? String(m.text).slice(0, 120) : labelOf(att)),
    kind:       m.deleted ? 'deleted' : (att ? att.kind : 'text'),
    deleted:    !!m.deleted,
    createdAt:  m.createdAt,
    mine:       senderId === String(userId),
  };
};

// From the payload that msg.toClient() produced (used for live updates)
const fromClient = (p, mine) => ({
  id:         p.id,
  senderId:   p.sender.id,
  senderName: p.sender.name,
  text:       p.text ? String(p.text).slice(0, 120) : labelOf(p.attachment),
  kind:       p.attachment ? p.attachment.kind : 'text',
  deleted:    false,
  createdAt:  p.createdAt,
  mine:       !!mine,
});

// Messages from other people that I have not read. If I have never read
// anything in this class, only messages since I joined count.
const unreadFilter = (cls, me, userId) => {
  const filter = {
    class:   cls._id,
    sender:  { $ne: userId },
    deleted: false,
  };
  if (me.lastRead) filter._id = { $gt: me.lastRead };
  else             filter.createdAt = { $gt: me.joinedAt };
  return filter;
};

// One { last, unread } per class, in the same order as `classes`
const previewsFor = (classes, userId) =>
  Promise.all(classes.map(async (cls) => {
    const me = cls.getMember(userId);
    if (!me || me.status !== 'active') return { last: null, unread: 0 };

    const [lastDoc, unreadRows] = await Promise.all([
      ClassMessage.findOne({ class: cls._id })
        .sort({ _id: -1 })
        .populate({ path: 'sender', select: 'profile.name username' }),
      ClassMessage.find(unreadFilter(cls, me, userId))
        .select('_id')
        .limit(MAX_UNREAD)
        .lean(),
    ]);

    return { last: fromDoc(lastDoc, userId), unread: unreadRows.length };
  }));

module.exports = { previewsFor, fromClient };