import express from "express"
import pg, { Client } from "pg"
import jwt from "jsonwebtoken"
import bcrypt from "bcrypt"
import cors from "cors"
import 'dotenv/config'
import pgclient from "../database/dbconnect.js"
const app=express();
app.use(express.json());
app.use(cors());



app.get("/health",(req,res)=>{
    res.send("the backend is up and healthy")
    pgclient.query("")
})


app.post("/signup",async (req,res)=>{
    try{
    const {phone,password,name}=req.body;
    const hashedpass=await bcrypt.hash(password,5)
    const response=await pgclient.query(
        "INSERT INTO users (phone_number, password_hash, name) VALUES ($1, $2, $3)",
        [phone, hashedpass, name]
    );
    if(response.rowCount!=0){
        console.log("entry created")
        return res.json({
            message:"entry created"
        })
    }
    }
    catch(e){
        return res.status(500).json({
            message:"error occured",
            error:e
        })
    }
    
})

app.post("/login",async (req,res)=>{
    try{
    const {phone,password}=req.body;
    const response=await pgclient.query("SELECT * FROM users WHERE phone_number =$1",[phone])
    if(response.rowCount!=0){
        const compare=await bcrypt.compare(password,response.rows[0].password_hash)
        if(compare){
            const token=jwt.sign({
                name:response.rows[0].name,
                phone:response.rows[0].phone_number,
                user_id:response.rows[0].id  
            },process.env.JWT_SECRET_KEY)
            return res.json({
                token:token
            })
        }
        else{
            return res.send("password is wrong");
        }
    }
    else{
        return res.send("entry does'nt exists")
    }
    }catch(e){
        console.log(e);
        return res.json({
            message:"error occured"
        })
    }

})

app.post('/myconversation',async (req,res)=>{
    try{
        const token=req.headers.token;
        console.log(token);
        const decode=jwt.verify(token,process.env.JWT_SECRET_KEY)
        const result = await pgclient.query(
            `SELECT * FROM conversations 
             WHERE user1_phone = $1 OR user2_phone = $1
             ORDER BY last_message_at DESC`,
            [decode.phone]
        );
        if(result.rowCount!=0){
            return res.send(result.rows)
        }
        return res.send("you dont have any active conversations present!")
        
    }catch(e){
        console.log(e)
        console.log("error occured");
    }
})


app.post('/getmessages', async (req, res) => {
    try {
        const token = req.headers.token;
        console.log("Token received:", token);

        if (!token) {
            return res.status(401).json({
                success: false,
                message: "No token provided"
            });
        }

        const decode = jwt.verify(token, process.env.JWT_SECRET_KEY);
        const { conversationId } = req.body;

        if (!conversationId) {
            return res.status(400).json({
                success: false,
                message: "Conversation ID is required"
            });
        }

        console.log("Fetching messages for conversation:", conversationId);

        const result = await pgclient.query(
            `SELECT * FROM messages 
             WHERE conversation_id = $1
             ORDER BY created_at ASC`,
            [conversationId]
        );

        if (result.rowCount !== 0) {
            return res.json({
                success: true,
                count: result.rowCount,
                messages: result.rows
            });
        }

        return res.json({
            success: true,
            count: 0,
            messages: [],
            message: "No messages found for this conversation"
        });

    } catch (error) {
        console.error("Error fetching messages:", error.message);

        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({
                success: false,
                message: "Invalid token"
            });
        }

        return res.status(500).json({
            success: false,
            message: "Error fetching messages",
            error: error.message
        });
    }
});

app.post('/getgroupmessages', async (req, res) => {
    try {
        const token = req.headers.token;
        console.log("Token received:", token);

        if (!token) {
            return res.status(401).json({
                success: false,
                message: "No token provided"
            });
        }

        const decode = jwt.verify(token, process.env.JWT_SECRET_KEY);
        const { groupId } = req.body;

        if (!groupId) {
            return res.status(400).json({
                success: false,
                message: "Group ID is required"
            });
        }

        console.log("Fetching group messages for group:", groupId);

        const participantCheck = await pgclient.query(
            `SELECT * FROM group_participants 
             WHERE group_id = $1 AND phone_number = $2`,
            [groupId, decode.phone]
        );

        if (participantCheck.rowCount === 0) {
            return res.status(403).json({
                success: false,
                message: "You are not a member of this group"
            });
        }

        const result = await pgclient.query(
            `SELECT 
                m.id,
                m.group_id,
                m.sender_phone,
                m.receiver_phone,
                m.content,
                m.status,
                m.delivered_at,
                m.seen_at,
                m.is_pinned,
                m.pinned_at,
                m.pinned_by,
                m.visibility,
                m.deleted_by,
                m.deleted_at,
                m.created_at,
                m.updated_at,
                u.name as sender_name
             FROM messages m
             JOIN users u ON m.sender_phone = u.phone_number
             WHERE m.group_id = $1
             ORDER BY m.created_at ASC`,
            [groupId]
        );

        return res.json({
            success: true,
            count: result.rowCount,
            messages: result.rows
        });

    } catch (error) {
        console.error("Error fetching group messages:", error.message);

        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({
                success: false,
                message: "Invalid token"
            });
        }

        return res.status(500).json({
            success: false,
            message: "Error fetching group messages",
            error: error.message
        });
    }
});

app.listen(8000);