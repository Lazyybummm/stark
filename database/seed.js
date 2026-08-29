// drop-and-seed.js
import pg from 'pg';
import 'dotenv/config';

const { Client } = pg;

const client = new Client({
    connectionString: process.env.DB_URL,
    ssl: { rejectUnauthorized: false }
});

async function resetDatabase() {
    console.log('🔌 Connecting to database...');
    await client.connect();
    console.log('✅ Connected!\n');

    try {
        // Drop tables in correct order (due to foreign keys)
        console.log('🗑️ Dropping existing tables...');
        await client.query(`DROP TABLE IF EXISTS group_message_read_receipts CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS group_messages CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS group_participants CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS groups CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS messages CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS conversations CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS users CASCADE;`);
        console.log('✅ Tables dropped\n');

        // ============================================================
        // 1. USERS TABLE
        // ============================================================
        console.log('📝 Creating users table...');
        await client.query(`
            CREATE TABLE users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                phone_number VARCHAR(15) UNIQUE NOT NULL,
                name VARCHAR(100) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                is_online BOOLEAN DEFAULT FALSE,
                last_seen TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log('✅ Users table created\n');

        // ============================================================
        // 2. CONVERSATIONS TABLE (1-on-1)
        // ============================================================
        console.log('📝 Creating conversations table...');
        await client.query(`
            CREATE TABLE conversations (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user1_phone VARCHAR(15) NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                user2_phone VARCHAR(15) NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                last_message_at TIMESTAMP DEFAULT NOW(),
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                CONSTRAINT unique_conversation UNIQUE (user1_phone, user2_phone)
            );
        `);
        console.log('✅ Conversations table created\n');

        // ============================================================
        // 3. MESSAGES TABLE (1-on-1)
        // ============================================================
        console.log('📝 Creating messages table...');
        await client.query(`
            CREATE TABLE messages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                sender_phone VARCHAR(15) NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                receiver_phone VARCHAR(15) NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                content TEXT NOT NULL,
                status VARCHAR(20) DEFAULT 'sent',
                delivered_at TIMESTAMP,
                seen_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log('✅ Messages table created\n');

        // ============================================================
        // 4. GROUPS TABLE
        // ============================================================
        console.log('📝 Creating groups table...');
        await client.query(`
            CREATE TABLE groups (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                group_name VARCHAR(100) NOT NULL,
                admin_phone VARCHAR(15) NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log('✅ Groups table created\n');

        // ============================================================
        // 5. GROUP PARTICIPANTS TABLE
        // ============================================================
        console.log('📝 Creating group_participants table...');
        await client.query(`
            CREATE TABLE group_participants (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                phone_number VARCHAR(15) NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                joined_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(group_id, phone_number)
            );
        `);
        console.log('✅ Group participants table created\n');

        // ============================================================
        // 6. GROUP MESSAGES TABLE
        // ============================================================
        console.log('📝 Creating group_messages table...');
        await client.query(`
            CREATE TABLE group_messages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                sender_phone VARCHAR(15) NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log('✅ Group messages table created\n');

        // ============================================================
        // 7. GROUP MESSAGE DELIVERY TABLE (Per-user tracking)
        // ============================================================
        console.log('📝 Creating group_message_delivery table...');
        await client.query(`
            CREATE TABLE group_message_delivery (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                message_id UUID NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
                phone_number VARCHAR(15) NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                status VARCHAR(20) DEFAULT 'sent',
                delivered_at TIMESTAMP,
                seen_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(message_id, phone_number)
            );
        `);
        console.log('✅ Group message delivery table created\n');

        // ============================================================
        // 8. GROUP MESSAGE READ RECEIPTS TABLE
        // ============================================================
        console.log('📝 Creating group_message_read_receipts table...');
        await client.query(`
            CREATE TABLE group_message_read_receipts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                message_id UUID NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
                phone_number VARCHAR(15) NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                seen_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(message_id, phone_number)
            );
        `);
        console.log('✅ Group message read receipts table created\n');

        // ============================================================
        // 9. INDEXES FOR PERFORMANCE
        // ============================================================
        console.log('📝 Creating indexes for performance...');

        // Users
        await client.query(`CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number);`);
        console.log('  ✅ idx_users_phone');

        // Conversations
        await client.query(`CREATE INDEX IF NOT EXISTS idx_conversations_user1 ON conversations(user1_phone);`);
        console.log('  ✅ idx_conversations_user1');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_conversations_user2 ON conversations(user2_phone);`);
        console.log('  ✅ idx_conversations_user2');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_at DESC);`);
        console.log('  ✅ idx_conversations_last_message');

        // Messages
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);`);
        console.log('  ✅ idx_messages_conversation');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_phone);`);
        console.log('  ✅ idx_messages_sender');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_receiver_status ON messages(receiver_phone, status);`);
        console.log('  ✅ idx_messages_receiver_status');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);`);
        console.log('  ✅ idx_messages_created');

        // Groups
        await client.query(`CREATE INDEX IF NOT EXISTS idx_groups_admin ON groups(admin_phone);`);
        console.log('  ✅ idx_groups_admin');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_groups_created ON groups(created_at DESC);`);
        console.log('  ✅ idx_groups_created');

        // Group participants
        await client.query(`CREATE INDEX IF NOT EXISTS idx_group_participants_group ON group_participants(group_id);`);
        console.log('  ✅ idx_group_participants_group');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_group_participants_phone ON group_participants(phone_number);`);
        console.log('  ✅ idx_group_participants_phone');

        // Group messages
        await client.query(`CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id);`);
        console.log('  ✅ idx_group_messages_group');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_group_messages_sender ON group_messages(sender_phone);`);
        console.log('  ✅ idx_group_messages_sender');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_group_messages_created ON group_messages(created_at DESC);`);
        console.log('  ✅ idx_group_messages_created');

        // Group message delivery
        await client.query(`CREATE INDEX IF NOT EXISTS idx_group_delivery_message ON group_message_delivery(message_id);`);
        console.log('  ✅ idx_group_delivery_message');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_group_delivery_phone ON group_message_delivery(phone_number);`);
        console.log('  ✅ idx_group_delivery_phone');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_group_delivery_status ON group_message_delivery(status);`);
        console.log('  ✅ idx_group_delivery_status');

        // Group read receipts
        await client.query(`CREATE INDEX IF NOT EXISTS idx_group_read_receipts_message ON group_message_read_receipts(message_id);`);
        console.log('  ✅ idx_group_read_receipts_message');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_group_read_receipts_phone ON group_message_read_receipts(phone_number);`);
        console.log('  ✅ idx_group_read_receipts_phone\n');

        // ============================================================
        // 10. TRIGGERS FOR updated_at
        // ============================================================
        console.log('📝 Creating update triggers...');

        await client.query(`
            CREATE OR REPLACE FUNCTION update_updated_at_column()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = NOW();
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);
        console.log('  ✅ update_updated_at_column function');

        await client.query(`
            DROP TRIGGER IF EXISTS update_users_updated_at ON users;
            CREATE TRIGGER update_users_updated_at
            BEFORE UPDATE ON users
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        `);
        console.log('  ✅ trigger on users');

        await client.query(`
            DROP TRIGGER IF EXISTS update_conversations_updated_at ON conversations;
            CREATE TRIGGER update_conversations_updated_at
            BEFORE UPDATE ON conversations
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        `);
        console.log('  ✅ trigger on conversations');

        await client.query(`
            DROP TRIGGER IF EXISTS update_messages_updated_at ON messages;
            CREATE TRIGGER update_messages_updated_at
            BEFORE UPDATE ON messages
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        `);
        console.log('  ✅ trigger on messages');

        await client.query(`
            DROP TRIGGER IF EXISTS update_groups_updated_at ON groups;
            CREATE TRIGGER update_groups_updated_at
            BEFORE UPDATE ON groups
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        `);
        console.log('  ✅ trigger on groups');

        await client.query(`
            DROP TRIGGER IF EXISTS update_group_messages_updated_at ON group_messages;
            CREATE TRIGGER update_group_messages_updated_at
            BEFORE UPDATE ON group_messages
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        `);
        console.log('  ✅ trigger on group_messages');

        await client.query(`
            DROP TRIGGER IF EXISTS update_group_message_delivery_updated_at ON group_message_delivery;
            CREATE TRIGGER update_group_message_delivery_updated_at
            BEFORE UPDATE ON group_message_delivery
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        `);
        console.log('  ✅ trigger on group_message_delivery\n');

        // ============================================================
        // 11. INSERT TEST USERS
        // ============================================================
        console.log('📝 Inserting test users...');

        await client.query(`
            INSERT INTO users (phone_number, name, password_hash) 
            VALUES 
                ('+919876543210', 'Alice', 'hashed_password_123'),
                ('+919999999999', 'Bob', 'hashed_password_456'),
                ('+919888888888', 'Charlie', 'hashed_password_789')
            ON CONFLICT (phone_number) DO NOTHING;
        `);
        console.log('  ✅ Test users inserted (Alice, Bob, Charlie)\n');

        // ============================================================
        // 12. VERIFY SETUP
        // ============================================================
        console.log('📊 Verifying setup...');

        const tablesResult = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            ORDER BY table_name;
        `);

        console.log('  ✅ Tables created:');
        tablesResult.rows.forEach(row => {
            console.log(`     - ${row.table_name}`);
        });

        const userCount = await client.query(`SELECT COUNT(*) FROM users`);
        console.log(`\n  👥 Users in database: ${userCount.rows[0].count}`);

        console.log('\n🎉 Database setup complete!');
        console.log('📋 Tables: users, conversations, messages, groups, group_participants, group_messages, group_message_delivery, group_message_read_receipts');

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
    } finally {
        await client.end();
        console.log('\n🔌 Database connection closed.');
    }
}

resetDatabase();