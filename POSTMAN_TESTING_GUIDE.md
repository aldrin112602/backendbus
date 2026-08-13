# 🧪 Postman Testing Guide for Notification System

## 📋 Prerequisites

1. **Postman installed** on your machine
2. **Server running** on `http://localhost:3000`
3. **Database updated** with the new notification schema
4. **Valid user UUIDs** for testing

## 🚀 Quick Start

### 1. Import the Collection
1. Open Postman
2. Click **Import** button
3. Select the `Notification_API_Postman_Collection.json` file
4. The collection will appear in your workspace

### 2. Set Up Environment Variables
1. Click on the collection name
2. Go to **Variables** tab
3. Update the following variables:

```json
{
  "base_url": "http://localhost:3000",
  "admin_user_id": "your-actual-admin-uuid",
  "client_user_id": "your-actual-client-uuid", 
  "employee_user_id": "your-actual-employee-uuid",
  "notification_id": "leave-empty-initially"
}
```

## 🔔 Testing Admin Endpoints

### **Step 1: Test Basic Connectivity**
1. Run **"Test Notification Routing"** first
   - Expected: `200 OK` with message "Notification routing is working!"

### **Step 2: Create Test Notifications**
1. **"Send Notification to Single User"**
   - Update `client_user_id` variable with a real UUID
   - Run the request
   - Expected: `201 Created` with notification details
   - **Copy the returned notification ID** to `notification_id` variable

2. **"Send Notification to Specific Users"**
   - Update both `client_user_id` and `employee_user_id`
   - Run the request
   - Expected: `201 Created` with message "Notifications sent to 2 recipient(s)"

3. **"Broadcast to All Clients"**
   - Run the request
   - Expected: `201 Created` with message "Broadcast notification sent to X client(s)"

### **Step 3: View and Analyze**
1. **"Get All Notifications (Admin View)"**
   - Run with default filters
   - Expected: `200 OK` with paginated notifications
   - Check pagination info in response

2. **"Get Notification Statistics"**
   - Run to see overall stats
   - Expected: `200 OK` with counts, distributions, and daily stats

## 👤 Testing Client Endpoints

### **Step 1: View Client Notifications**
1. **"Get Client Notifications"**
   - Ensure `client_user_id` is set correctly
   - Run with filters: `type=announcement`, `is_read=false`, `priority=high`
   - Expected: `200 OK` with filtered notifications

2. **"Get Client Notifications - All Types"**
   - Run without type filtering
   - Expected: `200 OK` with all notifications for the client

### **Step 2: Test Read Operations**
1. **"Mark Notification as Read"**
   - Ensure `notification_id` is set to a real notification ID
   - Run the request
   - Expected: `200 OK` with updated notification (is_read: true)

2. **"Mark All Notifications as Read"**
   - Run to mark all unread notifications as read
   - Expected: `200 OK` with count of updated notifications

### **Step 3: Test Delete Operations**
1. **"Delete Specific Notification"**
   - Set `notification_id` to a notification you want to delete
   - Run the request
   - Expected: `200 OK` with message "Notification deleted successfully"

2. **"Delete All Read Notifications"**
   - Run to clean up read notifications
   - Expected: `200 OK` with count of deleted notifications

### **Step 4: Check Unread Count**
1. **"Get Unread Count"**
   - Run to see current unread count
   - Expected: `200 OK` with `unreadCount` field

## 👷 Testing Employee Endpoints

### **Step 1: View Employee Notifications**
1. **"Get Employee Notifications"**
   - Ensure `employee_user_id` is set correctly
   - Run with filters: `type=maintenance`, `is_read=false`
   - Expected: `200 OK` with filtered notifications

2. **"Get Employee Notifications - All Types"**
   - Run without type filtering
   - Expected: `200 OK` with all notifications for the employee

### **Step 2: Test Read Operations**
1. **"Mark Employee Notification as Read"**
   - Set `notification_id` to a real notification ID
   - Run the request
   - Expected: `200 OK` with updated notification

## 🔍 Testing Utility Endpoints

### **Step 1: Admin Recipient View**
1. **"Get Notifications by Recipient ID (Admin View)"**
   - Set recipient ID in URL path
   - Run with filters
   - Expected: `200 OK` with paginated notifications for specific user

### **Step 2: Specific Notification View**
1. **"Get Specific Notification by ID (Admin View)"**
   - Set `notification_id` to a real notification ID
   - Run the request
   - Expected: `200 OK` with notification details including recipient info

## 📊 Expected Response Examples

### **Successful Notification Creation**
```json
{
  "message": "Notifications sent to 2 recipient(s)",
  "notifications": [
    {
      "id": "uuid",
      "recipient_id": "user-uuid",
      "type": "announcement",
      "title": "Test Title",
      "message": "Test message",
      "is_read": false,
      "priority": "normal",
      "created_at": "2024-01-15T10:00:00Z"
    }
  ]
}
```

### **Paginated Notifications Response**
```json
{
  "notifications": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 45,
    "totalPages": 3
  }
}
```

### **Statistics Response**
```json
{
  "total": 150,
  "unread": 45,
  "read": 105,
  "byType": {
    "general": 50,
    "announcement": 30,
    "maintenance": 20
  },
  "byDate": {
    "2024-01-15": 10,
    "2024-01-14": 15
  }
}
```

## 🚨 Common Error Responses

### **400 Bad Request**
```json
{
  "error": "Missing required fields: recipient_ids, type, and message"
}
```

### **404 Not Found**
```json
{
  "error": "Notification not found or access denied"
}
```

### **500 Internal Server Error**
```json
{
  "error": "Database connection error"
}
```

## 🔧 Troubleshooting

### **Issue: "Collection not importing"**
- Ensure the JSON file is valid
- Check Postman version compatibility

### **Issue: "Variables not working"**
- Verify variables are set in collection variables
- Check for typos in variable names

### **Issue: "Server connection refused"**
- Ensure your Node.js server is running
- Check if port 3000 is correct
- Verify firewall settings

### **Issue: "Database errors"**
- Ensure you've run the database schema updates
- Check Supabase connection
- Verify table structure

## 📝 Testing Checklist

- [ ] Import Postman collection
- [ ] Set up environment variables
- [ ] Test basic connectivity
- [ ] Create test notifications
- [ ] Test admin endpoints
- [ ] Test client endpoints  
- [ ] Test employee endpoints
- [ ] Test utility endpoints
- [ ] Verify pagination works
- [ ] Test all CRUD operations
- [ ] Verify real-time functionality

## 🎯 Advanced Testing Scenarios

### **Scenario 1: High Volume Testing**
1. Create 100+ notifications using loops
2. Test pagination with large datasets
3. Verify performance under load

### **Scenario 2: Edge Cases**
1. Test with invalid UUIDs
2. Test with empty message bodies
3. Test with very long messages
4. Test with special characters

### **Scenario 3: Real-time Testing**
1. Open multiple browser tabs
2. Send notifications from Postman
3. Verify real-time updates in browser

## 🔒 Security Testing

- Test with invalid user IDs
- Test cross-user access attempts
- Verify role-based access control
- Test SQL injection attempts

## 📈 Performance Testing

- Monitor response times
- Test with large datasets
- Verify index effectiveness
- Check memory usage

## 🎉 Success Criteria

Your notification system is working correctly when:

1. ✅ All endpoints return expected status codes
2. ✅ Notifications are created with correct data
3. ✅ Pagination works for large datasets
4. ✅ Filters work correctly
5. ✅ CRUD operations succeed
6. ✅ Real-time updates work
7. ✅ Error handling is appropriate
8. ✅ Performance is acceptable

## 🆘 Getting Help

If you encounter issues:

1. Check the server console for error logs
2. Verify database schema is updated
3. Check Supabase dashboard for connection issues
4. Ensure all environment variables are set correctly
5. Test with simple requests first

Happy testing! 🚀
