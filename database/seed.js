// drop-and-seed-unified.js
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
        await client.query(`DROP TABLE IF EXISTS group_message_delivery CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS messages CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS group_participants CASCADE;`);
        await client.query(`DROP TABLE IF EXISTS groups CASCADE;`);
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
        // 3. GROUPS TABLE
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
        // 4. GROUP PARTICIPANTS TABLE
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
        // 5. UNIFIED MESSAGES TABLE (1-on-1 + Groups)
        // ============================================================
        console.log('📝 Creating unified messages table...');
        await client.query(`
            CREATE TABLE messages (
                -- Primary Key
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                
                -- Polymorphic References (Exactly ONE must be non-NULL)
                conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
                group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
                
                -- Sender
                sender_phone VARCHAR(15) NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                
                -- For 1-on-1 messages only (NULL for group messages)
                receiver_phone VARCHAR(15) REFERENCES users(phone_number) ON DELETE CASCADE,
                
                -- Content
                content TEXT NOT NULL,
                
                -- Delivery Status (for 1-on-1)
                status VARCHAR(20) DEFAULT 'sent',
                delivered_at TIMESTAMP,
                seen_at TIMESTAMP,
                
                -- 🔒 PINNING FEATURE
                is_pinned BOOLEAN DEFAULT FALSE,
                pinned_at TIMESTAMP,
                pinned_by VARCHAR(15) REFERENCES users(phone_number) ON DELETE SET NULL,
                
                -- 🔒 DELETION/VISIBILITY FEATURE
                visibility VARCHAR(50) DEFAULT 'all',
                deleted_by VARCHAR(15) REFERENCES users(phone_number) ON DELETE SET NULL,
                deleted_at TIMESTAMP,
                
                -- Timestamps
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                
                -- 🔑 Constraint: Exactly ONE of conversation_id or group_id must be set
                CONSTRAINT check_message_type CHECK (
                    (conversation_id IS NOT NULL AND group_id IS NULL) OR
                    (conversation_id IS NULL AND group_id IS NOT NULL)
                ),
                
                -- 🔑 Constraint: receiver_phone must be NULL for group messages
                CONSTRAINT check_receiver_phone CHECK (
                    (group_id IS NOT NULL AND receiver_phone IS NULL) OR
                    (conversation_id IS NOT NULL)
                )
            );
        `);
        console.log('✅ Unified messages table created\n');

        // ============================================================
        // 6. GROUP MESSAGE DELIVERY TABLE (Per-user tracking for groups)
        // ============================================================
        console.log('📝 Creating group_message_delivery table...');
        await client.query(`
            CREATE TABLE group_message_delivery (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
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
        // 7. GROUP MESSAGE READ RECEIPTS TABLE
        // ============================================================
        console.log('📝 Creating group_message_read_receipts table...');
        await client.query(`
            CREATE TABLE group_message_read_receipts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                phone_number VARCHAR(15) NOT NULL REFERENCES users(phone_number) ON DELETE CASCADE,
                seen_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(message_id, phone_number)
            );
        `);
        console.log('✅ Group message read receipts table created\n');

        // ============================================================
        // 8. INDEXES FOR PERFORMANCE
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

        // Messages - Primary lookup indexes
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id) WHERE conversation_id IS NOT NULL;`);
        console.log('  ✅ idx_messages_conversation');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id) WHERE group_id IS NOT NULL;`);
        console.log('  ✅ idx_messages_group');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_phone);`);
        console.log('  ✅ idx_messages_sender');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_phone);`);
        console.log('  ✅ idx_messages_receiver');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);`);
        console.log('  ✅ idx_messages_created');

        // Messages - Pinning indexes
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_pinned_conversation 
            ON messages(conversation_id, is_pinned DESC) 
            WHERE conversation_id IS NOT NULL AND is_pinned = true;
        `);
        console.log('  ✅ idx_messages_pinned_conversation');
        
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_pinned_group 
            ON messages(group_id, is_pinned DESC) 
            WHERE group_id IS NOT NULL AND is_pinned = true;
        `);
        console.log('  ✅ idx_messages_pinned_group');

        // Messages - Visibility indexes
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_visibility ON messages(visibility);`);
        console.log('  ✅ idx_messages_visibility');
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_pinned_by ON messages(pinned_by);`);
        console.log('  ✅ idx_messages_pinned_by');

        // Messages - Status indexes
        await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);`);
        console.log('  ✅ idx_messages_status');

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
        // 9. TRIGGERS FOR updated_at
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

        // Users trigger
        await client.query(`
            DROP TRIGGER IF EXISTS update_users_updated_at ON users;
            CREATE TRIGGER update_users_updated_at
            BEFORE UPDATE ON users
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        `);
        console.log('  ✅ trigger on users');

        // Conversations trigger
        await client.query(`
            DROP TRIGGER IF EXISTS update_conversations_updated_at ON conversations;
            CREATE TRIGGER update_conversations_updated_at
            BEFORE UPDATE ON conversations
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        `);
        console.log('  ✅ trigger on conversations');

        // Messages trigger
        await client.query(`
            DROP TRIGGER IF EXISTS update_messages_updated_at ON messages;
            CREATE TRIGGER update_messages_updated_at
            BEFORE UPDATE ON messages
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        `);
        console.log('  ✅ trigger on messages');

        // Groups trigger
        await client.query(`
            DROP TRIGGER IF EXISTS update_groups_updated_at ON groups;
            CREATE TRIGGER update_groups_updated_at
            BEFORE UPDATE ON groups
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        `);
        console.log('  ✅ trigger on groups');

        // Group message delivery trigger
        await client.query(`
            DROP TRIGGER IF EXISTS update_group_message_delivery_updated_at ON group_message_delivery;
            CREATE TRIGGER update_group_message_delivery_updated_at
            BEFORE UPDATE ON group_message_delivery
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        `);
        console.log('  ✅ trigger on group_message_delivery\n');

        // ============================================================
        // 10. INSERT TEST USERS
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
        // 11. ADD COLUMN COMMENTS
        // ============================================================
        console.log('📝 Adding column comments...');

        await client.query(`
            COMMENT ON COLUMN messages.conversation_id IS 'For 1-on-1 messages (NULL for group messages)';
            COMMENT ON COLUMN messages.group_id IS 'For group messages (NULL for 1-on-1 messages)';
            COMMENT ON COLUMN messages.receiver_phone IS 'For 1-on-1 messages only (NULL for group messages)';
            COMMENT ON COLUMN messages.is_pinned IS 'Whether the message is pinned';
            COMMENT ON COLUMN messages.pinned_at IS 'When the message was pinned';
            COMMENT ON COLUMN messages.pinned_by IS 'Who pinned the message';
            COMMENT ON COLUMN messages.visibility IS 'Visibility: all, none, all_except_sender, all_except_user:phone';
            COMMENT ON COLUMN messages.deleted_by IS 'Who deleted the message';
            COMMENT ON COLUMN messages.deleted_at IS 'When the message was deleted';
        `);
        console.log('  ✅ Comments added to messages table\n');

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
        console.log('📋 Tables: users, conversations, groups, group_participants, messages, group_message_delivery, group_message_read_receipts');
        console.log('\n📋 Unified messages table supports both 1-on-1 and group messages!');
        console.log('   🔹 conversation_id → 1-on-1 messages');
        console.log('   🔹 group_id → Group messages');
        console.log('   🔹 Exactly ONE of the above must be set');

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
    } finally {
        await client.end();
        console.log('\n🔌 Database connection closed.');
    }
}

resetDatabase();