# 🚌 Bus Tracking System API

A comprehensive REST API for managing bus tracking, booking, and fleet management operations. Built with Node.js, Express, and Supabase for real-time capabilities.

## 📋 Table of Contents

- [Features](#-features)
- [Tech Stack](#-tech-stack)
- [Prerequisites](#-prerequisites)
- [Installation](#-installation)
- [Environment Setup](#-environment-setup)
- [Database Schema](#-database-schema)
- [API Endpoints](#-api-endpoints)
- [Authentication](#-authentication)
- [Real-time Features](#-real-time-features)
- [Usage Examples](#-usage-examples)
- [Error Handling](#-error-handling)
- [Contributing](#-contributing)

## ✨ Features

### 🎯 Core Features
- **Multi-role System**: Admin, Client, Employee (Driver/Conductor)
- **Real-time Bus Tracking**: Live location updates and ETA calculations
- **Booking Management**: Seat booking with automatic availability tracking
- **Fleet Management**: Complete bus, route, and terminal management
- **Employee Management**: Account creation, assignment, and status management
- **Feedback System**: Rating and comment system with analytics
- **Notification System**: Real-time notifications for all users
- **Report Management**: Incident reporting for employees

### 🔐 Security Features
- Supabase Authentication
- Role-based access control
- Email validation
- Password protection
- Session management

### 📊 Analytics & Insights
- Transit insights dashboard
- Feedback statistics
- Booking analytics
- Employee performance tracking

## 🛠 Tech Stack

- **Backend**: Node.js, Express.js
- **Database**: Supabase (PostgreSQL)
- **Authentication**: Supabase Auth
- **Real-time**: Supabase Realtime
- **CORS**: Cross-origin resource sharing enabled
- **Environment**: dotenv for configuration

## 📋 Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Supabase account and project
- Git

## 🚀 Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd backendBustracking
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   ```

4. **Configure your environment variables**
   ```env
   SUPABASE_URL=your_supabase_project_url
   SUPABASE_ANON_KEY=your_supabase_anon_key
   PORT=3000
   ```

5. **Start the server**
   ```bash
   npm start
   ```

   Or for development:
   ```bash
   npm run dev
   ```

## 🔧 Environment Setup

### Supabase Configuration

1. Create a new Supabase project
2. Get your project URL and anon key from the API settings
3. Set up the following tables in your Supabase database:

### Required Tables
- `users` - User accounts and profiles
- `buses` - Bus fleet information
- `routes` - Bus routes
- `terminals` - Bus terminals/stops
- `route_stops` - Route stop mappings
- `bookings` - Passenger bookings
- `feedbacks` - User feedback
- `notifications` - System notifications
- `reports` - Employee reports

## 📊 Database Schema

### Key Tables Structure

#### Users Table
```sql
- id (UUID, Primary Key)
- username (String)
- email (String, Unique)
- role (Enum: 'admin', 'client', 'driver', 'conductor')
- profile (JSONB)
- assigned_bus_id (UUID, Foreign Key)
- status (Enum: 'pending', 'active', 'inactive')
- created_at (Timestamp)
```

#### Buses Table
```sql
- id (UUID, Primary Key)
- bus_number (String)
- total_seats (Integer)
- available_seats (Integer)
- current_location (JSONB)
- status (Enum: 'active', 'inactive', 'maintenance')
- route_id (UUID, Foreign Key)
- driver_id (UUID, Foreign Key)
- conductor_id (UUID, Foreign Key)
- terminal_id (UUID, Foreign Key)
```

## 🔌 API Endpoints

### Authentication Endpoints

#### User Registration
```http
POST /api/auth/signup
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123",
  "username": "john_doe",
  "role": "client",
  "profile": {
    "fullName": "John Doe",
    "phone": "+1234567890"
  }
}
```

#### User Login
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123"
}
```

#### Employee Login
```http
POST /api/auth/employee-login
Content-Type: application/json

{
  "email": "driver@company.com",
  "password": "password123"
}
```

### Client Endpoints

#### Get Bus ETA
```http
GET /api/client/bus-eta
```

**Response:**
```json
[
  {
    "busId": "uuid",
    "busNumber": "BUS001",
    "eta": "15 minutes",
    "currentLocation": {"lat": 40.7128, "lng": -74.0060},
    "route": {
      "name": "Downtown Express",
      "start_terminal_id": "uuid",
      "end_terminal_id": "uuid"
    }
  }
]
```

#### Create Booking
```http
POST /api/client/booking
Content-Type: application/json

{
  "userId": "user-uuid",
  "busId": "bus-uuid"
}
```

#### Get User Bookings
```http
GET /api/client/bookings
```

#### Submit Feedback
```http
POST /api/client/feedback
Content-Type: application/json

{
  "userId": "user-uuid",
  "busId": "bus-uuid",
  "rating": 5,
  "comment": "Great service!"
}
```

#### Get Notifications
```http
GET /api/client/notifications?userId=user-uuid
```

### Admin Endpoints

#### Transit Insights
```http
GET /api/admin/transit-insights
```

#### Terminal Management

**Create Terminal**
```http
POST /api/admin/terminal
Content-Type: application/json

{
  "name": "Central Terminal",
  "address": "123 Main St, City"
}
```

**List Terminals**
```http
GET /api/admin/terminals
```

**Update Terminal**
```http
PUT /api/admin/terminal/:id
Content-Type: application/json

{
  "name": "Updated Terminal Name",
  "address": "456 New St, City"
}
```

**Delete Terminal**
```http
DELETE /api/admin/terminal/:id
```

#### Route Management

**Create Route**
```http
POST /api/admin/route
Content-Type: application/json

{
  "name": "Downtown Express",
  "start_terminal_id": "terminal-uuid",
  "end_terminal_id": "terminal-uuid",
  "stops": ["stop1-uuid", "stop2-uuid"]
}
```

**List Routes**
```http
GET /api/admin/routes
```

**Update Route**
```http
PUT /api/admin/route/:id
Content-Type: application/json

{
  "name": "Updated Route Name",
  "start_terminal_id": "terminal-uuid",
  "end_terminal_id": "terminal-uuid",
  "stops": ["stop1-uuid", "stop2-uuid"]
}
```

**Delete Route**
```http
DELETE /api/admin/route/:id
```

#### Bus Management

**Create Bus**
```http
POST /api/admin/bus
Content-Type: application/json

{
  "bus_number": "BUS001",
  "total_seats": 50,
  "terminal_id": "terminal-uuid",
  "route_id": "route-uuid"
}
```

**List Buses**
```http
GET /api/admin/buses
```

**Get Bus Locations**
```http
GET /api/admin/bus-locations
```

#### User Management

**Get All Users**
```http
GET /api/admin/users
```

**Get Users by Role**
```http
GET /api/admin/users/clients
GET /api/admin/users/employees
GET /api/admin/users/drivers
GET /api/admin/users/conductors
```

**Create Employee**
```http
POST /api/admin/employee/create
Content-Type: application/json

{
  "fullName": "John Driver",
  "phone": "+1234567890",
  "role": "driver",
  "email": "driver@company.com",
  "password": "password123",
  "busId": "bus-uuid"
}
```

**Confirm Employee**
```http
PUT /api/admin/employee/:id/confirm
```

**Assign Employee to Bus**
```http
PUT /api/admin/employee/assign-bus
Content-Type: application/json

{
  "busId": "bus-uuid",
  "email": "driver@company.com"
}
```

#### Booking Management

**Confirm Booking**
```http
PUT /api/admin/booking/:id/confirm
```

#### Feedback Management

**Get All Feedback**
```http
GET /api/admin/feedbacks
```

**Get Feedback Statistics**
```http
GET /api/admin/feedbacks/stats
```

**Get Feedback by Bus**
```http
GET /api/admin/feedbacks/bus/:busId
```

**Get Feedback by User**
```http
GET /api/admin/feedbacks/user/:userId
```

#### Report Management

**Get All Reports**
```http
GET /api/admin/reports
```

#### Notification Management

**Send Notification**
```http
POST /api/admin/notification
Content-Type: application/json

{
  "recipientId": "user-uuid",
  "type": "announcement",
  "message": "Service update notification"
}
```

### Employee Endpoints

#### Submit Report
```http
POST /api/employee/report
Content-Type: application/json

{
  "employeeId": "employee-uuid",
  "busId": "bus-uuid",
  "type": "incident",
  "description": "Bus breakdown on route"
}
```

#### Update Passenger Count
```http
PUT /api/employee/passenger-count/:busId
Content-Type: application/json

{
  "action": "add" // or "remove"
}
```

#### Get Notifications
```http
GET /api/employee/notifications?employeeId=employee-uuid
```

#### Get Assigned Bus
```http
GET /api/employee/my-bus?email=driver@company.com
```

## 🔐 Authentication

The API uses Supabase Authentication with the following features:

- **Email/Password Authentication**
- **Role-based Access Control**
- **Session Management**
- **Account Status Management**

### User Roles

1. **Admin**: Full system access
2. **Client**: Booking and feedback access
3. **Driver**: Bus operation and reporting
4. **Conductor**: Passenger management and reporting

### Authentication Flow

1. User registers with email/password
2. Admin confirms employee accounts (if applicable)
3. Users login with credentials
4. Session tokens are managed by Supabase
5. Role-based endpoints are protected

## 🔄 Real-time Features

The system includes real-time capabilities through Supabase:

### Notifications
- Real-time notification delivery
- Automatic notifications for booking confirmations
- Employee assignment notifications
- System announcements

### Live Tracking
- Real-time bus location updates
- Live passenger count updates
- Instant status changes

## 📝 Usage Examples

### Frontend Integration

#### JavaScript/React Example
```javascript
// Get bus ETA
const getBusETA = async () => {
  const response = await fetch('/api/client/bus-eta');
  const buses = await response.json();
  return buses;
};

// Create booking
const createBooking = async (userId, busId) => {
  const response = await fetch('/api/client/booking', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ userId, busId }),
  });
  return await response.json();
};

// Employee login
const employeeLogin = async (email, password) => {
  const response = await fetch('/api/auth/employee-login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  return await response.json();
};
```

#### cURL Examples

**Get Bus ETA**
```bash
curl -X GET http://localhost:3000/api/client/bus-eta
```

**Create Booking**
```bash
curl -X POST http://localhost:3000/api/client/booking \
  -H "Content-Type: application/json" \
  -d '{"userId": "user-uuid", "busId": "bus-uuid"}'
```

**Employee Login**
```bash
curl -X POST http://localhost:3000/api/auth/employee-login \
  -H "Content-Type: application/json" \
  -d '{"email": "driver@company.com", "password": "password123"}'
```

## ⚠️ Error Handling

The API implements comprehensive error handling:

### HTTP Status Codes
- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `500` - Internal Server Error

### Error Response Format
```json
{
  "error": "Error message description"
}
```

### Common Error Scenarios
- Invalid credentials
- Missing required fields
- Resource not found
- Permission denied
- Database constraints violated

## 🧪 Testing

### API Testing
```bash
# Test server health
curl http://localhost:3000/api/health

# Test authentication
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "password"}'
```

### Environment Testing
```bash
# Check environment variables
node -e "console.log(process.env.SUPABASE_URL)"
```

## 🚀 Deployment

### Production Setup

1. **Environment Variables**
   ```env
   NODE_ENV=production
   PORT=3000
   SUPABASE_URL=your_production_supabase_url
   SUPABASE_ANON_KEY=your_production_supabase_key
   ```

2. **Process Management**
   ```bash
   npm install -g pm2
   pm2 start server.js --name "bus-tracking-api"
   pm2 save
   pm2 startup
   ```

3. **Reverse Proxy (Nginx)**
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;
       
       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

## 📈 Performance Considerations

- **Database Indexing**: Ensure proper indexes on frequently queried fields
- **Connection Pooling**: Supabase handles connection management
- **Caching**: Implement Redis for frequently accessed data
- **Rate Limiting**: Consider implementing rate limiting for public endpoints
- **Compression**: Enable gzip compression for responses

## 🔒 Security Best Practices

- Use HTTPS in production
- Implement rate limiting
- Validate all input data
- Use environment variables for sensitive data
- Regular security updates
- Monitor for suspicious activities

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Follow the existing code style
- Add proper error handling
- Include API documentation
- Write tests for new features
- Update this README if needed

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

For support and questions:

- Create an issue in the repository
- Contact the development team
- Check the documentation

## 🔄 Version History

- **v1.0.0** - Initial release with core features
- **v1.1.0** - Added real-time notifications
- **v1.2.0** - Enhanced feedback system
- **v1.3.0** - Improved employee management

---

**Built with ❤️ for efficient bus tracking and management** 