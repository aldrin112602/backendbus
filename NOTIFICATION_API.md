# 🔔 Notification System API Documentation

## Overview

The notification system provides real-time alerts and updates for all users in the bus tracking system. It includes comprehensive CRUD operations, real-time subscriptions, and role-based access control.

## 🚀 Features

- **Real-time Notifications**: Instant delivery using Supabase Realtime
- **Multi-recipient Support**: Send to individual users or broadcast to roles
- **Priority Levels**: Low, Normal, High, Urgent
- **Read/Unread Tracking**: Mark notifications as read with timestamps
- **Pagination**: Efficient data loading for large notification lists
- **Filtering**: By type, read status, priority, and recipient
- **Statistics**: Comprehensive analytics for admins

## 📋 Notification Types

| Type | Description | Priority |
|------|-------------|----------|
| `delay` | Bus delay notifications | High |
| `route_change` | Route modification alerts | High |
| `traffic` | Traffic condition updates | Normal |
| `general` | General system messages | Normal |
| `announcement` | Important announcements | High |
| `maintenance` | Maintenance alerts | Urgent |

## 🔌 API Endpoints

### Admin Endpoints

#### Send Notification to Specific Users
```http
POST /api/admin/notification
Content-Type: application/json

{
  "recipient_ids": ["user-uuid-1", "user-uuid-2"],
  "type": "announcement",
  "message": "System maintenance scheduled for tomorrow",
  "title": "Maintenance Notice"
}
```

**Response:**
```json
{
  "message": "Notifications sent to 2 recipient(s)",
  "notifications": [...]
}
```

#### Broadcast to Role
```http
POST /api/admin/notification/broadcast
Content-Type: application/json

{
  "role": "client",
  "type": "general",
  "message": "New features available in the app",
  "title": "App Update"
}
```

#### Get All Notifications (Admin View)
```http
GET /api/admin/notifications?page=1&limit=50&type=general&is_read=false
```

#### Get Notification Statistics
```http
GET /api/admin/notifications/stats
```

**Response:**
```json
{
  "total": 150,
  "unread": 45,
  "read": 105,
  "byType": {
    "general": 50,
    "delay": 30,
    "maintenance": 20
  },
  "byDate": {
    "2024-01-15": 10,
    "2024-01-14": 15
  }
}
```

### Client Endpoints

#### Get Notifications
```http
GET /api/client/notifications?userId=user-uuid&page=1&limit=20&type=general&is_read=false&priority=high
```

**Response:**
```json
{
  "notifications": [
    {
      "id": "uuid",
      "type": "announcement",
      "title": "Service Update",
      "message": "New routes available",
      "is_read": false,
      "priority": "high",
      "created_at": "2024-01-15T10:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 45,
    "totalPages": 3
  }
}
```

#### Mark as Read
```http
PUT /api/client/notification/{id}/read
Content-Type: application/json

{
  "userId": "user-uuid"
}
```

#### Mark All as Read
```http
PUT /api/client/notifications/read-all
Content-Type: application/json

{
  "userId": "user-uuid"
}
```

#### Delete Notification
```http
DELETE /api/client/notification/{id}
Content-Type: application/json

{
  "userId": "user-uuid"
}
```

#### Delete All Read Notifications
```http
DELETE /api/client/notifications/delete-read
Content-Type: application/json

{
  "userId": "user-uuid"
}
```

#### Get Unread Count
```http
GET /api/client/notifications/unread-count?userId=user-uuid
```

**Response:**
```json
{
  "unreadCount": 5
}
```

### Employee Endpoints

#### Get Notifications
```http
GET /api/employee/notifications?employeeId=employee-uuid&page=1&limit=20&type=maintenance&is_read=false
```

#### Mark as Read
```http
PUT /api/employee/notification/{id}/read
Content-Type: application/json

{
  "employeeId": "employee-uuid"
}
```

## 🔄 Real-time Features

### Frontend Integration

The system automatically creates real-time channels for each user when they fetch notifications. Here's how to integrate:

```javascript
// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Subscribe to notifications for a specific user
const subscribeToNotifications = (userId) => {
  const channel = supabase
    .channel(`notifications_${userId}`)
    .on('postgres_changes', 
      { 
        event: 'INSERT', 
        schema: 'public', 
        table: 'notifications',
        filter: `recipient_id=eq.${userId}`
      }, 
      (payload) => {
        console.log('New notification:', payload.new);
        // Handle new notification (e.g., show toast, update UI)
        showNotificationToast(payload.new);
      }
    )
    .on('postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'notifications',
        filter: `recipient_id=eq.${userId}`
      },
      (payload) => {
        console.log('Notification updated:', payload.new);
        // Handle notification update
        updateNotificationInUI(payload.new);
      }
    )
    .on('postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'notifications',
        filter: `recipient_id=eq.${userId}`
      },
      (payload) => {
        console.log('Notification deleted:', payload.old);
        // Handle notification deletion
        removeNotificationFromUI(payload.old.id);
      }
    )
    .subscribe();

  return channel;
};

// Usage
const notificationChannel = subscribeToNotifications('user-uuid');

// Cleanup when component unmounts
const cleanup = () => {
  notificationChannel.unsubscribe();
};
```

## 📱 Usage Examples

### React Component Example

```jsx
import React, { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';

const NotificationCenter = ({ userId }) => {
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);

  // Fetch notifications
  const fetchNotifications = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/client/notifications?userId=${userId}&page=1&limit=20`);
      const data = await response.json();
      setNotifications(data.notifications);
    } catch (error) {
      console.error('Error fetching notifications:', error);
    } finally {
      setLoading(false);
    }
  };

  // Mark as read
  const markAsRead = async (notificationId) => {
    try {
      await fetch(`/api/client/notification/${notificationId}/read`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });
      
      // Update local state
      setNotifications(prev => 
        prev.map(n => 
          n.id === notificationId 
            ? { ...n, is_read: true, read_at: new Date().toISOString() }
            : n
        )
      );
      
      // Update unread count
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch (error) {
      console.error('Error marking as read:', error);
    }
  };

  // Delete notification
  const deleteNotification = async (notificationId) => {
    try {
      await fetch(`/api/client/notification/${notificationId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });
      
      // Remove from local state
      setNotifications(prev => prev.filter(n => n.id !== notificationId));
    } catch (error) {
      console.error('Error deleting notification:', error);
    }
  };

  // Get unread count
  const fetchUnreadCount = async () => {
    try {
      const response = await fetch(`/api/client/notifications/unread-count?userId=${userId}`);
      const data = await response.json();
      setUnreadCount(data.unreadCount);
    } catch (error) {
      console.error('Error fetching unread count:', error);
    }
  };

  useEffect(() => {
    fetchNotifications();
    fetchUnreadCount();
  }, [userId]);

  return (
    <div className="notification-center">
      <div className="notification-header">
        <h3>Notifications ({unreadCount} unread)</h3>
        <button onClick={() => fetchNotifications()}>Refresh</button>
      </div>
      
      {loading ? (
        <div>Loading...</div>
      ) : (
        <div className="notification-list">
          {notifications.map(notification => (
            <div 
              key={notification.id} 
              className={`notification-item ${notification.is_read ? 'read' : 'unread'} ${notification.priority}`}
            >
              <div className="notification-content">
                {notification.title && (
                  <h4>{notification.title}</h4>
                )}
                <p>{notification.message}</p>
                <small>{new Date(notification.created_at).toLocaleString()}</small>
              </div>
              
              <div className="notification-actions">
                {!notification.is_read && (
                  <button onClick={() => markAsRead(notification.id)}>
                    Mark Read
                  </button>
                )}
                <button onClick={() => deleteNotification(notification.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default NotificationCenter;
```

## 🎨 CSS Styling Example

```css
.notification-center {
  max-width: 600px;
  margin: 0 auto;
  padding: 20px;
}

.notification-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 10px;
  border-bottom: 2px solid #eee;
}

.notification-list {
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.notification-item {
  padding: 15px;
  border-radius: 8px;
  border-left: 4px solid #ddd;
  background: #fff;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  transition: all 0.3s ease;
}

.notification-item:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 8px rgba(0,0,0,0.15);
}

.notification-item.unread {
  border-left-color: #007bff;
  background: #f8f9ff;
}

.notification-item.high {
  border-left-color: #ffc107;
}

.notification-item.urgent {
  border-left-color: #dc3545;
  background: #fff5f5;
}

.notification-content h4 {
  margin: 0 0 8px 0;
  color: #333;
}

.notification-content p {
  margin: 0 0 8px 0;
  color: #666;
  line-height: 1.4;
}

.notification-content small {
  color: #999;
  font-size: 0.85em;
}

.notification-actions {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.notification-actions button {
  padding: 6px 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9em;
  transition: background-color 0.2s ease;
}

.notification-actions button:first-child {
  background: #007bff;
  color: white;
}

.notification-actions button:first-child:hover {
  background: #0056b3;
}

.notification-actions button:last-child {
  background: #6c757d;
  color: white;
}

.notification-actions button:last-child:hover {
  background: #545b62;
}
```

## 🔧 Database Schema Updates

The notifications table has been enhanced with new fields:

```sql
CREATE TABLE public.notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL,
  type text NOT NULL CHECK (type = ANY (ARRAY['delay', 'route_change', 'traffic', 'general', 'announcement', 'maintenance'])),
  title text,
  message text NOT NULL,
  is_read boolean DEFAULT false,
  priority text DEFAULT 'normal' CHECK (priority = ANY (ARRAY['low', 'normal', 'high', 'urgent'])),
  read_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id)
);

-- Performance indexes
CREATE INDEX idx_notifications_recipient_id ON public.notifications(recipient_id);
CREATE INDEX idx_notifications_type ON public.notifications(type);
CREATE INDEX idx_notifications_is_read ON public.notifications(is_read);
CREATE INDEX idx_notifications_created_at ON public.notifications(created_at);
CREATE INDEX idx_notifications_priority ON public.notifications(priority);
```

## 🚨 Error Handling

All endpoints return consistent error responses:

```json
{
  "error": "Error message description"
}
```

Common HTTP status codes:
- `200` - Success
- `201` - Created
- `400` - Bad Request (missing/invalid parameters)
- `404` - Not Found
- `500` - Internal Server Error

## 🔒 Security Features

- **User Verification**: All operations verify the user owns the notification
- **Role-based Access**: Different endpoints for different user types
- **Input Validation**: Comprehensive validation of all input parameters
- **SQL Injection Protection**: Using Supabase's parameterized queries

## 📊 Performance Considerations

- **Pagination**: All list endpoints support pagination
- **Indexes**: Database indexes on frequently queried fields
- **Real-time Channels**: Efficient subscription management
- **Connection Cleanup**: Automatic cleanup of unused channels

## 🧪 Testing

Use the test endpoint to verify the notification system is working:

```http
GET /api/admin/notification/test
```

This will return:
```json
{
  "message": "Notification routing is working!"
}
```
