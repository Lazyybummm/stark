import pgclient from "../database/dbconnect.js";

export function onlineCheck(receiver_phone, mappings) {
    const value = mappings.get(receiver_phone);
    if (value) {
        return 'delivered';
    } else {
        return 'sent';
    }
}

export async function removeParticipant(roomId, phone) {
    try {
        const response = await pgclient.query(
            `DELETE FROM group_participants 
             WHERE group_id = $1 AND phone_number = $2
             RETURNING id, group_id, phone_number, joined_at`,
            [roomId, phone]
        );
        if (response.rowCount !== 0) {
            return {
                success: true,
                message: 'user removed from the group'
            };
        } else {
            return {
                success: false,
                message: 'User is not a member of this group'
            };
        }
    } catch (error) {
        return {
            success: false,
            message: error.message
        };
    }
}

export async function leaveGroup(phone, groupId, groups) {
    try {
        const response = await pgclient.query(
            `DELETE FROM group_participants 
             WHERE group_id = $1 AND phone_number = $2
             RETURNING id, group_id, phone_number, joined_at`,
            [groupId, phone]
        );
        if (response.rowCount !== 0) {
            if (groups.has(groupId)) {
                groups.get(groupId).delete(phone);
                if (groups.get(groupId).size === 0) {
                    groups.delete(groupId);
                }
            }
            return {
                success: true,
                message: "user left the group"
            };
        } else {
            return {
                success: false,
                message: "User is not a member of this group"
            };
        }
    } catch (error) {
        return {
            success: false,
            message: error.message
        };
    }
}

export async function createRoom(adminPhone, groupName, groups) {
    try {
        const groupResult = await pgclient.query(
            `INSERT INTO groups (group_name, admin_phone) 
             VALUES ($1, $2) 
             RETURNING id, group_name, admin_phone, created_at`,
            [groupName, adminPhone]
        );

        await pgclient.query(
            `INSERT INTO group_participants (group_id, phone_number) 
             VALUES ($1, $2)`,
            [groupResult.rows[0].id, adminPhone]
        );

        groups.set(groupResult.rows[0].id, new Set([adminPhone]));
        return {
            success: true,
            correctid: groupResult.rows[0].id
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

export async function addtoRoom(rec_phone, roomId, groups) {
    try {
        const result = await pgclient.query(
            `INSERT INTO group_participants (group_id, phone_number) 
             VALUES ($1, $2) 
             ON CONFLICT (group_id, phone_number) DO NOTHING
             RETURNING id, group_id, phone_number, joined_at`,
            [roomId, rec_phone]
        );

        groups.get(roomId).add(rec_phone);
        return {
            success: true,
            message: "user added to the room"
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

export async function sendtoRoom(sender_phone, roomId, content, groups, mappings) {
    try {
        const messageResult = await pgclient.query(
            `INSERT INTO messages (group_id, sender_phone, content, receiver_phone) 
             VALUES ($1, $2, $3, NULL) 
             RETURNING id, group_id, sender_phone, content, created_at`,
            [roomId, sender_phone, content]
        );
        const msgId = messageResult.rows[0].id;
        await pgclient.query(
            `INSERT INTO group_message_delivery (message_id, phone_number, status) 
             VALUES ($1, $2, $3)`,
            [msgId, sender_phone, 'sent']
        );
        const participants = groups.get(roomId);

        const arr = [];

        for (const phone of participants) {
            if (phone == sender_phone) continue;

            await pgclient.query(
                `INSERT INTO group_message_delivery (message_id, phone_number, status) 
                 VALUES ($1, $2, $3)`,
                [msgId, phone, 'sent']
            );

            const sock = mappings.get(phone);
            if (sock) {
                arr.push(sock);
            }
        }
        arr.forEach((c) => {
            c.send(JSON.stringify({
                message: messageResult.rows[0],
                event: "group message recieved"
            }));
        });

        return {
            success: true,
            message: "message sent succesfully",
            messageId: messageResult.rows[0].id
        };
    } catch (error) {
        return {
            success: false,
            message: "error occured with sending your message",
            error: error.message
        };
    }
}

export function sendToRecipient(recipientPhone, payload, mappings) {
    const sock = mappings.get(recipientPhone);
    if (sock && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify(payload));
        return true;
    }
    return false;
}

export function broadcastToParticipants(participants, payload, mappings) {
    if (!participants) return;
    participants.forEach((phone) => {
        const sock = mappings.get(phone);
        if (sock && sock.readyState === WebSocket.OPEN) {
            sock.send(JSON.stringify(payload));
        }
    });
}

export async function getAdminCheck(groupId) {
    return await pgclient.query(
        `SELECT admin_phone, group_name FROM groups WHERE id = $1`,
        [groupId]
    );
}

export async function updatePinStatus(msgId, sender_phone, isPinned) {
    const query = isPinned
        ? `UPDATE messages SET is_pinned = true, pinned_at = NOW(), pinned_by = $1 WHERE id = $2 RETURNING *`
        : `UPDATE messages SET is_pinned = false, pinned_at = NULL, pinned_by = NULL WHERE id = $1 RETURNING *`;

    const params = isPinned ? [sender_phone, msgId] : [msgId];
    const result = await pgclient.query(query, params);
    return result.rows[0];
}

export async function deleteMessageForMe(msgId, sender_phone) {
    return await pgclient.query(
        `UPDATE messages 
         SET visibility = 'all_except_sender',
             deleted_by = $1,
             deleted_at = NOW()
         WHERE id = $2 AND sender_phone = $1`,
        [sender_phone, msgId]
    );
}

export async function deleteMessageForEveryone(msgId, sender_phone) {
    const result = await pgclient.query(
        `UPDATE messages 
         SET visibility = 'none',
             deleted_by = $1,
             deleted_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [sender_phone, msgId]
    );
    return result.rows[0];
}