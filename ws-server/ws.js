import ws, {  WebSocketServer } from "ws";
import jwt from "jsonwebtoken";
import 'dotenv/config';
import pgclient from "../database/dbconnect.js";
import { json } from "express";
import http from "http";
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

const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'OK', 
            timestamp: new Date().toISOString(),
            connections: wss ? wss.clients.size : 0 
        }));
        return;
    }
    
   
    if (req.url === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('WebSocket Server is running');
        return;
    }
    
   
    res.end('Not Found');
});


const wss = new WebSocketServer({ server });

const mappings = new Map();
const pubsub=new Map();
const phonelookups = new Map();
const groups = new Map();
groups.set('1', new Set(['1']));
pubsub.set('111',new Set(['444']))

function removeWatcherFromAllTargets(phone_number) {
    const targetsToRemove = [];
    for (const [target, subscribers] of pubsub) {
        subscribers.delete(phone_number);
        if (subscribers.size === 0) {
            targetsToRemove.push(target);
        }
    }
    for (const target of targetsToRemove) {
        pubsub.delete(target);
    }
}

wss.on("connection", async (socket) => {
    socket.send("connected");
   
    socket.on("close", async () => {

        const phone_number = phonelookups.get(socket);
        const Watchers=pubsub.get(phone_number);//see if the user was a target ->hsould return a set , the nuiane s an empty set is also truthy so we are gonna check size
        if(Watchers && Watchers.size>0){
            for (let entry of Watchers){
                const sock=mappings.get(entry);
                sock.send(JSON.stringify({
                    event:'active status',
                    user:phone_number,
                    status:'offline'
                }))
            }
        }

        removeWatcherFromAllTargets(phone_number);//removing user as a watcher from all the targets , 

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
                const Watchers=pubsub.get(info.phone)
                if(Watchers && Watchers.size>0){
                    for (let entry of Watchers){
                        const sock=mappings.get(entry);
                        sock.send(JSON.stringify({
                            event:'active status',
                            user:info.phone,
                            status:'online'
                        }))
                    }
                }

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
            const reply_to = payload.data.reply_to || null;
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

                let replyContent = null;
                let replySenderPhone = null;
                let replySenderName = null;

                if (reply_to) {
                    const replyResult = await pgclient.query(
                        `SELECT m.content, m.sender_phone, u.name 
                         FROM messages m
                         JOIN users u ON m.sender_phone = u.phone_number
                         WHERE m.id = $1`,
                        [reply_to]
                    );
                    if (replyResult.rowCount > 0) {
                        replyContent = replyResult.rows[0].content;
                        replySenderPhone = replyResult.rows[0].sender_phone;
                        replySenderName = replyResult.rows[0].name;
                    }
                }

                const messageresult = await pgclient.query(
                    `INSERT INTO messages (conversation_id, sender_phone, receiver_phone, content, status, reply_to, reply_content, reply_sender_phone, reply_sender_name) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
                     RETURNING id, sender_phone, receiver_phone, content, created_at, reply_to, reply_content, reply_sender_phone, reply_sender_name`,
                    [conversationId, sender_phone, rec_phone, payload.data.content, status, reply_to, replyContent, replySenderPhone, replySenderName]
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

                let replyContent = null;
                let replySenderPhone = null;
                let replySenderName = null;

                if (reply_to) {
                    const replyResult = await pgclient.query(
                        `SELECT m.content, m.sender_phone, u.name 
                         FROM messages m
                         JOIN users u ON m.sender_phone = u.phone_number
                         WHERE m.id = $1`,
                        [reply_to]
                    );
                    if (replyResult.rowCount > 0) {
                        replyContent = replyResult.rows[0].content;
                        replySenderPhone = replyResult.rows[0].sender_phone;
                        replySenderName = replyResult.rows[0].name;
                    }
                }

                const messageResult = await pgclient.query(
                    `INSERT INTO messages (conversation_id, sender_phone, receiver_phone, content, status, reply_to, reply_content, reply_sender_phone, reply_sender_name) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
                     RETURNING id, conversation_id, sender_phone, receiver_phone, content, created_at, reply_to, reply_content, reply_sender_phone, reply_sender_name`,
                    [conversationId, sender_phone, rec_phone, payload.data.content, status, reply_to, replyContent, replySenderPhone, replySenderName]
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
            const convId=payload.data.convId;
            sendToRecipient(rec_phone, {
                sender_phone: payload.data.sender_phone,
                convId:convId,
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
            const reply_to = payload.data.reply_to || null;

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
            const rec_phone=payload.data.rec_phone;
            const sock=mappings.get(rec_phone);
            if(sock && sock.readyState==WebSocket.OPEN){
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
           
        }else if (topic == 'seenbatch') {
            const msgIds = payload.data.msgIds;
            const msgType = payload.data.type;
            const seenBy = phonelookups.get(socket);
        
            if (!msgIds || msgIds.length === 0) {
                socket.send(JSON.stringify({
                    event: 'error',
                    message: 'No message IDs provided'
                }));
                return;
            }
        
            try {
                if (msgType === 'conversation') {
                    const result = await pgclient.query(//directly marking the status of the message and sending the event to the recipient
                        `UPDATE messages 
                         SET status = 'seen', seen_at = NOW()
                         WHERE id = ANY($1) AND receiver_phone = $2
                         RETURNING id, sender_phone, conversation_id`,
                        [msgIds, seenBy]
                    );
        
                    if (result.rowCount > 0) {
                        const senders = [...new Set(result.rows.map(r => r.sender_phone))];
                        for (const sender of senders) {
                            const senderSocket = mappings.get(sender);
                            if (senderSocket && senderSocket.readyState === WebSocket.OPEN) {
                                const seenMsgIds = result.rows
                                    .filter(r => r.sender_phone === sender)
                                    .map(r => r.id);
                                
                                senderSocket.send(JSON.stringify({
                                    event: 'seen_batch_success',
                                    data: {
                                        messageIds: seenMsgIds,
                                        seenBy: seenBy,
                                        seenAt: new Date().toISOString(),
                                        msgType: 'conversation'
                                    }
                                }));
                            }
                        }
                    }
        
                } else if (msgType === 'group') {
                    const groupResult = await pgclient.query(
                        `SELECT DISTINCT group_id FROM messages 
                         WHERE id = ANY($1) AND group_id IS NOT NULL`,
                        [msgIds]
                    );
        
                    if (groupResult.rowCount === 0) {
                        socket.send(JSON.stringify({
                            event: 'error',
                            message: 'No group messages found'
                        }));
                        return;
                    }
        
                    const groupId = groupResult.rows[0].group_id;
        
                    let updatedCount = 0;
                    for (const msgId of msgIds) {
                        const deliveryResult = await pgclient.query(
                            `UPDATE group_message_delivery 
                             SET status = 'seen', seen_at = NOW()
                             WHERE message_id = $1 AND phone_number = $2
                             RETURNING message_id`,
                            [msgId, seenBy]
                        );
                        updatedCount += deliveryResult.rowCount;
                    }
        
                    const senderResult = await pgclient.query(
                        `SELECT DISTINCT sender_phone FROM messages 
                         WHERE id = ANY($1)`,
                        [msgIds]
                    );
        
                    for (const row of senderResult.rows) {
                        const senderSocket = mappings.get(row.sender_phone);
                        if (senderSocket && senderSocket.readyState === WebSocket.OPEN) {
                            senderSocket.send(JSON.stringify({
                                event: 'seen_batch_success',
                                data: {
                                    messageIds: msgIds,
                                    seenBy: seenBy,
                                    seenAt: new Date().toISOString(),
                                    msgType: 'group',
                                    groupId: groupId,
                                    count: updatedCount
                                }
                            }));
                        }
                    }
                }
        
                socket.send(JSON.stringify({
                    event: 'seen_batch_success',
                    data: {
                        messageIds: msgIds,
                        status: 'confirmed',
                        seenBy: seenBy,
                        seenAt: new Date().toISOString()
                    }
                }));
        
            } catch (error) {
                console.error('Seen batch error:', error);
                socket.send(JSON.stringify({
                    event: 'error',
                    message: 'Failed to mark messages as seen: ' + error.message
                }));
            }
        }
        else if(topic=='grouptyping'){
            const groupId=payload.data.groupId;
            const sender_phone=payload.data.sender_phone;
            const participants=groups.get(groupId);//returns a set of participants
            for(let i of participants){
                if(i==sender_phone){continue;}
                const sock=mappings.get(i);
                if(sock.readyState==WebSocket.OPEN){
                sock.send(JSON.stringify({
                    event:'group-typing',
                    sender_phone:sender_phone,
                    groupId:groupId
                }))
            }
            }
        }
        else if(topic=='subscribe'){
            const sender_phone=phonelookups.get(socket);
            const rec_phone=payload.data.rec_phone;
           const subscribers=pubsub.get(rec_phone);
           if(subscribers){
            subscribers.add(sender_phone);
           }
           else{
            pubsub.set(rec_phone, new Set([sender_phone])); 
           }
        }
        else if(topic=='unsubscribe'){
            const sender_phone=phonelookups.get(socket);
            const rec_phone=payload.data.rec_phone;
            const subscribers=pubsub.get(rec_phone);
            if(subscribers){
                subscribers.delete(sender_phone);
                if(subscribers.size==0){
                    pubsub.delete(rec_phone);//delete this entry to prevent memory leak ->need to look at this more 
                }
            }
            
        }
    });
});


const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(` WebSocket server running on ws://localhost:${PORT}`);
    console.log(`Health endpoint available at http://localhost:${PORT}/health`);
    console.log(`Ready for Render deployment`);
});


console.log("WebSocket server running on ws://localhost:8080");