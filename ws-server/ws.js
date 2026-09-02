import ws, { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";
import 'dotenv/config';
import pgclient from "../database/dbconnect.js";
import { json } from "express";
import {
    onlineCheck,
    removeParticipant,
    leaveGroup,
    createRoom,
    addtoRoom,
    sendtoRoom,
    sendToRecipient,
    broadcastToParticipants,
    getAdminCheck,
    updatePinStatus,
    deleteMessageForMe,
    deleteMessageForEveryone
} from "./utils.js";

const wss = new WebSocketServer({ port: 8080 });

const mappings = new Map();
const phonelookups = new Map();
const groups = new Map();
groups.set('1', new Set(['1']));

wss.on("connection", async (socket) => {
    socket.send("connected");

    socket.on("close", async () => {
        const phone_number = phonelookups.get(socket);
        const sock = mappings.get(phone_number);
        phonelookups.delete(sock);
        mappings.delete(phone_number);
        await pgclient.query(
            `UPDATE users SET is_online = false, last_seen = NOW() 
             WHERE phone_number = $1`,
            [phone_number]
        );
    });

    socket.on("message", async (data) => {
        const payload = JSON.parse(data.toString('utf8'));
        const topic = payload.event;

        if (topic == "auth") {
            try {
                const info = jwt.verify(payload.data, process.env.JWT_SECRET_KEY);
                mappings.set(info.phone, socket);
                phonelookups.set(socket, info.phone);

                const response = await pgclient.query(
                    `SELECT 
                        g.id,
                        g.group_name,
                        g.admin_phone,
                        g.created_at,
                        array_agg(gp.phone_number) as participants
                     FROM groups g
                     JOIN group_participants gp ON g.id = gp.group_id
                     WHERE g.id IN (
                         SELECT group_id FROM group_participants WHERE phone_number = $1
                     )
                     GROUP BY g.id, g.group_name, g.admin_phone, g.created_at`,
                    [info.phone]
                );

                response.rows.forEach((c) => {
                    if (!groups.has(c.id)) {
                        groups.set(c.id, new Set(c.participants));
                    } else {
                        groups.get(c.id).add(info.phone);
                    }
                });

                socket.send(JSON.stringify({
                    message: response.rows,
                    event: "group-data"
                }));
            } catch (e) {
                socket.send(JSON.stringify({
                    message: "please login again",
                    event: "auth"
                }));
                socket.close();
            }
        } else if (topic == "chat") {
            const sender_phone = payload.data.sender_phonenum;
            const rec_phone = payload.data.reciever_phonenum;
            const tempid = payload.data.tempid;
            const status = onlineCheck(rec_phone, mappings);

            const response = await pgclient.query(
                `SELECT * FROM conversations 
                 WHERE (user1_phone = $1 AND user2_phone = $2)
                    OR (user1_phone = $2 AND user2_phone = $1)`,
                [rec_phone, sender_phone]
            );

            let conversationId;

            if (response.rowCount != 0) {
                conversationId = response.rows[0].id;

                const messageresult = await pgclient.query(
                    `INSERT INTO messages (conversation_id, sender_phone, receiver_phone, content, status) 
                     VALUES ($1, $2, $3, $4, $5) 
                     RETURNING id, sender_phone, receiver_phone, content, created_at`,
                    [conversationId, sender_phone, rec_phone, payload.data.content, status]
                );

                const delivered = sendToRecipient(rec_phone, {
                    content: messageresult.rows[0],
                    event: "chat"
                }, mappings);

                socket.send(JSON.stringify({
                    correctid: messageresult.rows[0].id,
                    tempid: tempid,
                    status: delivered ? "delivered" : "sent"
                }));
            } else {
                const newConvo = await pgclient.query(
                    `INSERT INTO conversations (user1_phone, user2_phone, last_message_at) 
                     VALUES ($1, $2, NOW()) 
                     RETURNING id`,
                    [sender_phone, rec_phone]
                );

                conversationId = newConvo.rows[0].id;

                const messageResult = await pgclient.query(
                    `INSERT INTO messages (conversation_id, sender_phone, receiver_phone, content, status) 
                     VALUES ($1, $2, $3, $4, $5) 
                     RETURNING id, conversation_id, sender_phone, receiver_phone, content, created_at`,
                    [conversationId, sender_phone, rec_phone, payload.data.content, status]
                );

                const delivered = sendToRecipient(rec_phone, {
                    messageResult: messageResult.rows[0],
                    event: "chat"
                }, mappings);

                socket.send(JSON.stringify({
                    tempid: tempid,
                    correctid: messageResult.rows[0].id,
                    status: delivered ? "delivered" : "sent"
                }));
            }
        } else if (topic == 'typing') {
            const rec_phone = payload.data.reciever_phonenum;
            sendToRecipient(rec_phone, {
                sender_phone: payload.data.sender_phone,
                event: "typing"
            }, mappings);
        } else if (topic == 'seen') {
            const messageId = payload.data.messageId;
            const rec_phone = payload.data.rec_phone;

            await pgclient.query(
                `UPDATE messages SET status = 'seen', seen_at = NOW() 
                 WHERE id = $1`,
                [messageId]
            );

            sendToRecipient(rec_phone, {
                messageId: messageId,
                event: "seen"
            }, mappings);
        } else if (topic == 'create-room') {
            const data = await createRoom(payload.data.sender_phone, payload.data.group_name, groups);
            if (data.success) {
                socket.send(JSON.stringify({
                    message: "room created succesfully",
                    tempid: payload.data.tempid,
                    correctid: data.correctid
                }));
            } else {
                socket.send(JSON.stringify({
                    message: "something went wrong with the group creation",
                    event: "error",
                    err_msg: data.error
                }));
            }
        } else if (topic == 'addtoroom') {
            const roomId = payload.data.roomId;
            const rec_phone = payload.data.receiver_phone;
            const sender_phone = payload.data.sender_phone;

            const content = await pgclient.query(
                `SELECT id, group_name, admin_phone, created_at, updated_at
                 FROM groups WHERE id = $1`,
                [roomId]
            );

            if (content.rowCount == 0) {
                socket.send(JSON.stringify({
                    message: "room does'nt exists",
                    event: 'invalid room creds'
                }));
                return;
            }

            const data = content.rows[0];

            if (data.admin_phone == sender_phone) {
                const response = await addtoRoom(rec_phone, roomId, groups);
                if (response.success) {
                    sendToRecipient(rec_phone, {
                        message: "you are added to a room ",
                        groupName: data.group_name,
                        created_at: data.created_at,
                        adminPhone: sender_phone,
                        event: "added to a room"
                    }, mappings);

                    socket.send(JSON.stringify({
                        message: "user added to the room",
                        event: "user added"
                    }));
                }
            } else {
                socket.send(JSON.stringify({
                    message: "not authorized to add members",
                    event: "unathorized action"
                }));
            }
        } else if (topic == 'sendtoroom') {
            const roomId = payload.data.roomId;
            const tempmsgId = payload.data.tempmsgId;
            const sender_phone = payload.data.sender_phone;
            const content = payload.data.message;

            const response = await sendtoRoom(sender_phone, roomId, content, groups, mappings);
            if (response.success) {
                socket.send(JSON.stringify({
                    message: response.message,
                    tempmsgId: tempmsgId,
                    correctid: response.messageId
                }));
            } else {
                socket.send(JSON.stringify({
                    message: response.message,
                    error: response.error
                }));
            }
        } else if (topic == 'leaveroom') {
            const phone = payload.data.sender_phone;
            const roomId = payload.data.roomId;
            const newAdmin = payload.data.newAdmin;

            if (newAdmin) {
                await pgclient.query(
                    `UPDATE groups SET admin_phone = $1 WHERE id = $2`,
                    [newAdmin, roomId]
                );
            }

            const response = await leaveGroup(phone, roomId, groups);
            if (response.success) {
                socket.send(JSON.stringify({
                    message: response.message,
                    event: 'left-group'
                }));

                const currentParticipants = groups.get(roomId);
                if (currentParticipants && currentParticipants.size != 0) {
                    broadcastToParticipants(currentParticipants, {
                        message: phone + ' has left the group',
                        roomId: roomId,
                        event: 'notify others'
                    }, mappings);
                }
            } else {
                socket.send(JSON.stringify({
                    message: response.message,
                    event: 'issue with group leaving'
                }));
            }
        } else if (topic == 'removeuser') {
            const roomId = payload.data.roomId;
            const phone = payload.data.receiver_phone;

            const check = groups.get(roomId).has(phone);
            if (check) {
                const response = await removeParticipant(roomId, phone);
                if (response.success) {
                    groups.get(roomId).delete(phone);

                    sendToRecipient(phone, {
                        roomId: roomId,
                        event: 'removed from the group'
                    }, mappings);

                    sendToRecipient(phone, {
                        message: 'user removed from the group',
                        event: 'user removal'
                    }, mappings);

                    const remainingParticipants = groups.get(roomId);
                    if (remainingParticipants && remainingParticipants.size != 0) {
                        broadcastToParticipants(remainingParticipants, {
                            message: phone + ' has been removed from the group',
                            roomId: roomId,
                            event: 'notify others'
                        }, mappings);
                    }

                    socket.send(JSON.stringify({
                        message: 'user removed successfully',
                        event: 'removal success'
                    }));
                } else {
                    socket.send(JSON.stringify({
                        message: response.message,
                        event: 'error while removal'
                    }));
                }
                return;
            }

            socket.send(JSON.stringify({
                message: 'user not in group',
                event: 'not participant'
            }));
        } else if (topic == 'deletegroup') {
            const roomId = payload.data.roomId;
            const sender_phone = payload.data.sender_phone;

            try {
                const adminCheck = await getAdminCheck(roomId);

                if (adminCheck.rowCount === 0) {
                    socket.send(JSON.stringify({
                        event: 'error',
                        message: 'Group not found'
                    }));
                    return;
                }

                const groupData = adminCheck.rows[0];

                if (groupData.admin_phone !== sender_phone) {
                    socket.send(JSON.stringify({
                        event: 'error',
                        message: 'Only group admin can delete the group'
                    }));
                    return;
                }

                const response = await pgclient.query(
                    `DELETE FROM groups WHERE id = $1
                     RETURNING id, group_name, admin_phone`,
                    [roomId]
                );

                if (response.rowCount === 0) {
                    socket.send(JSON.stringify({
                        event: 'error',
                        message: 'Failed to delete group'
                    }));
                    return;
                }

                const deletedGroup = response.rows[0];
                const participants = groups.get(roomId);

                broadcastToParticipants(participants, {
                    event: 'group_deleted',
                    data: {
                        groupId: roomId,
                        groupName: deletedGroup.group_name,
                        deletedBy: sender_phone,
                        deletedAt: new Date().toISOString()
                    }
                }, mappings);

                groups.delete(roomId);

                socket.send(JSON.stringify({
                    event: 'delete_success',
                    data: {
                        groupId: roomId,
                        groupName: deletedGroup.group_name,
                        message: 'Group deleted successfully'
                    }
                }));
            } catch (error) {
                console.error('Delete group error:', error);
                socket.send(JSON.stringify({
                    event: 'error',
                    message: 'Failed to delete group: ' + error.message
                }));
            }
        } else if (topic == 'pinmsg') {
            const msgId = payload.data.msgId;
            const sender_phone = payload.data.sender_phone;

            const result = await updatePinStatus(msgId, sender_phone, true);
            const groupId = result.group_id;
            const convId = result.conversation_id;

            if (groupId) {
                const participants = groups.get(groupId);
                broadcastToParticipants(participants, {
                    pinInfo: result,
                    event: 'pinned'
                }, mappings);
                return;
            }

            if (convId) {
                sendToRecipient(result.receiver_phone, {
                    pinInfo: result,
                    event: 'pinned'
                }, mappings);
                return;
            }
        } else if (topic == 'unpin') {
            const msgId = payload.data.msgId;
            const sender_phone = payload.data.sender_phone;

            const result = await updatePinStatus(msgId, sender_phone, false);
            const groupId = result.group_id;
            const convId = result.conversation_id;

            if (groupId) {
                const participants = groups.get(groupId);
                broadcastToParticipants(participants, {
                    pinInfo: result,
                    event: 'unpinned'
                }, mappings);
                return;
            }

            if (convId) {
                sendToRecipient(result.receiver_phone, {
                    pinInfo: result,
                    event: 'unpinned'
                }, mappings);
                return;
            }
        } else if (topic == 'deletforme') {
            const msgId = payload.data.msgId;
            const sender_phone = payload.data.sender_phone;

            await deleteMessageForMe(msgId, sender_phone);
        } else if (topic == 'globaldelete') {
            const msgId = payload.data.msgId;
            const sender_phone = payload.data.sender_phone;
            const msgType = payload.data.msgType;

            try {
                const updatedMsg = await deleteMessageForEveryone(msgId, sender_phone);

                if (!updatedMsg) {
                    socket.send(JSON.stringify({
                        event: 'error',
                        message: 'Message not found'
                    }));
                    return;
                }

                if (updatedMsg.group_id) {
                    const groupId = updatedMsg.group_id;
                    const participants = groups.get(groupId);

                    if (participants) {
                        broadcastToParticipants(participants, {
                            event: 'message_global_deleted',
                            data: {
                                messageId: msgId,
                                msgType: 'group',
                                visibility: 'none',
                                deletedBy: sender_phone,
                                deletedAt: new Date().toISOString(),
                                message: updatedMsg
                            }
                        }, mappings);
                    }
                }

                if (updatedMsg.conversation_id) {
                    sendToRecipient(updatedMsg.receiver_phone, {
                        event: 'message_global_deleted',
                        data: {
                            messageId: msgId,
                            msgType: 'conversation',
                            visibility: 'none',
                            deletedBy: sender_phone,
                            deletedAt: new Date().toISOString(),
                            message: updatedMsg
                        }
                    }, mappings);

                    const senderSocket = mappings.get(sender_phone);
                    if (senderSocket && senderSocket.readyState === WebSocket.OPEN) {
                        senderSocket.send(JSON.stringify({
                            event: 'message_global_deleted',
                            data: {
                                messageId: msgId,
                                msgType: 'conversation',
                                visibility: 'none',
                                deletedBy: sender_phone,
                                deletedAt: new Date().toISOString(),
                                message: updatedMsg
                            }
                        }));
                    }
                }

                socket.send(JSON.stringify({
                    event: 'global_delete_success',
                    data: {
                        messageId: msgId,
                        visibility: 'none',
                        deletedBy: sender_phone,
                        deletedAt: new Date().toISOString()
                    }
                }));

            } catch (error) {
                console.error('Global delete error:', error);
                socket.send(JSON.stringify({
                    event: 'error',
                    message: 'Failed to delete message: ' + error.message
                }));
            }
        }
        else if(topic=='active-status'){
            //just check if the recipient is connected to the wss
            const rec_phone=payload.data.rec_phone;
            const sock=mappings.get(rec_phone);
            if(sock && sock.readyState==WebSocket.OPEN){//lookup what's this and why just cjecking sock would be a issue 
                    socket.send(JSON.stringify({
                        status:'online',
                        event:'reciever status'
                    }))
                    return;
            }
            else{
                socket.send(JSON.stringify({
                    status:'offline',
                    event:'reciever status'
                }))
            }
           
        }
    });
});

console.log("WebSocket server running on ws://localhost:8080");