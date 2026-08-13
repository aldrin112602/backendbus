# API Testing Guide for Employee Management System

## Prerequisites
1. Run the `database-updates.sql` in your Supabase SQL Editor
2. Make sure your server is running: `npm run dev`
3. Use a tool like Postman, Insomnia, or curl for testing

## Testing Sequence

### 1. Verify Database Updates
First, check if the database updates worked:

```sql
-- Run in Supabase SQL Editor
SELECT * FROM employee_assignments;
SELECT bus_number, id FROM buses WHERE bus_number LIKE 'TEST-BUS%';
```

### 2. Test Current Endpoints (Should Work)

#### Get All Users
```bash
GET http://localhost:3000/api/admin/users
```

#### Get Employees (Current)
```bash
GET http://localhost:3000/api/admin/users/employees
```

#### Get Buses
```bash
GET http://localhost:3000/api/admin/buses
```

### 3. Test New Employee Creation (After Implementation)

#### Create Driver Employee
```bash
POST http://localhost:3000/api/admin/employee/create
Content-Type: application/json

{
  "fullName": "John Driver",
  "phone": "09171234567",
  "role": "driver",
  "employeeId": "DRV001"
}
```

#### Create Conductor Employee
```bash
POST http://localhost:3000/api/admin/employee/create
Content-Type: application/json

{
  "fullName": "Jane Conductor",
  "phone": "09187654321",
  "role": "conductor",
  "employeeId": "CON001"
}
```

### 4. Test Employee Login
```bash
POST http://localhost:3000/api/auth/employee-login
Content-Type: application/json

{
  "employeeId": "DRV001",
  "password": "DRV001123"
}
```

### 5. Test Role-Specific Endpoints

#### Get Drivers Only
```bash
GET http://localhost:3000/api/admin/users/drivers
```

#### Get Conductors Only
```bash
GET http://localhost:3000/api/admin/users/conductors
```

### 6. Test Bus Assignment

#### Assign Employee to Bus
```bash
PUT http://localhost:3000/api/admin/employee/DRV001/assign-bus
Content-Type: application/json

{
  "busId": "YOUR_TEST_BUS_ID_HERE"
}
```

#### Check Employee's Bus Assignment
```bash
GET http://localhost:3000/api/employee/my-bus?employeeId=DRV001
```

### 7. Test Updated Bus Reassignment
```bash
PUT http://localhost:3000/api/admin/bus/YOUR_BUS_ID/reassign
Content-Type: application/json

{
  "driverEmployeeId": "DRV001",
  "conductorEmployeeId": "CON001",
  "routeId": "YOUR_ROUTE_ID"
}
```

## Expected Responses

### Successful Employee Creation
```json
{
  "employee": {
    "id": "uuid-here",
    "username": "DRV001",
    "email": "DRV001@buscompany.com",
    "role": "driver",
    "employee_id": "DRV001",
    "status": "active"
  },
  "credentials": {
    "employeeId": "DRV001",
    "email": "DRV001@buscompany.com",
    "defaultPassword": "DRV001123",
    "message": "Employee can login with Employee ID or email"
  }
}
```

### Successful Employee Login
```json
{
  "user": {
    "id": "uuid-here",
    "email": "DRV001@buscompany.com"
  },
  "session": {
    "access_token": "jwt-token-here"
  },
  "employee": {
    "role": "driver",
    "assignedBusId": null,
    "employeeId": "DRV001"
  }
}
```

## Quick Test Script (curl)

Save this as `test-api.sh`:

```bash
#!/bin/bash
BASE_URL="http://localhost:3000"

echo "=== Testing Employee Management API ==="

echo "1. Testing current endpoints..."
curl -X GET "$BASE_URL/api/admin/users" | jq '.'

echo -e "\n2. Testing buses endpoint..."
curl -X GET "$BASE_URL/api/admin/buses" | jq '.'

echo -e "\n3. Creating test driver..."
curl -X POST "$BASE_URL/api/admin/employee/create" \
  -H "Content-Type: application/json" \
  -d '{
    "fullName": "Test Driver",
    "phone": "09171234567",
    "role": "driver",
    "employeeId": "TEST001"
  }' | jq '.'

echo -e "\n4. Testing employee login..."
curl -X POST "$BASE_URL/api/auth/employee-login" \
  -H "Content-Type: application/json" \
  -d '{
    "employeeId": "TEST001",
    "password": "TEST001123"
  }' | jq '.'

echo -e "\nTesting complete!"
```

## Troubleshooting

### Common Issues:

1. **Database constraint errors**: Make sure you ran the SQL updates
2. **Role validation errors**: Check if the role constraint was updated properly
3. **Missing bus/route IDs**: Use the GET endpoints to fetch valid IDs first

### Debug Queries:
```sql
-- Check if roles were updated
SELECT DISTINCT role FROM users;

-- Check test data
SELECT bus_number, id FROM buses WHERE bus_number LIKE 'TEST%';

-- Check constraints
SELECT constraint_name, check_clause 
FROM information_schema.check_constraints 
WHERE table_name = 'users';
```

## Next Steps After Testing

1. If basic tests pass, implement the new endpoints in server.js
2. Test each endpoint individually
3. Test the complete workflow: Create → Login → Assign → Check Assignment
4. Add authentication middleware for admin-only endpoints
5. Add input validation and error handling
