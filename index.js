const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { google } = require('googleapis');
const Airtable = require('airtable');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Configure Airtable
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base('appUNIsu8KgvOlmi0');

// Configure Gmail
const gmail = google.gmail('v1');
const auth = new google.auth.GoogleAuth({
  credentials: {
    type: 'service_account',
    private_key: process.env.GMAIL_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.GMAIL_CLIENT_EMAIL,
    client_id: process.env.GMAIL_CLIENT_ID,
    project_id: process.env.GMAIL_PROJECT_ID
  },
  scopes: ['https://www.googleapis.com/auth/gmail.send']
});

// Logs array to store recent activities
let recentLogs = [];

function addLog(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, message, type };
  recentLogs.unshift(logEntry);
  
  // Keep only last 50 logs
  if (recentLogs.length > 50) {
    recentLogs = recentLogs.slice(0, 50);
  }
  
  console.log(`[${timestamp}] ${type.toUpperCase()}: ${message}`);
}

// Create Failed Payments table structure (if it doesn't exist)
async function ensureFailedPaymentsTable() {
  try {
    // Check if table exists by trying to fetch records
    const records = await base('Failed Payments').select({ maxRecords: 1 }).firstPage();
    addLog('Failed Payments table already exists');
    return true;
  } catch (error) {
    addLog('Failed Payments table needs to be created manually in Airtable', 'warning');
    addLog('Please create a table called "Failed Payments" with these fields:', 'info');
    addLog('- Payment ID (Single line text)', 'info');
    addLog('- Customer Email (Email)', 'info');
    addLog('- Customer Name (Single line text)', 'info');
    addLog('- Amount (Currency)', 'info');
    addLog('- Currency (Single line text)', 'info');
    addLog('- Failure Reason (Single line text)', 'info');
    addLog('- Failed At (Date)', 'info');
    addLog('- Status (Single select: Failed, Retrying, Resolved)', 'info');
    return false;
  }
}

// Send Gmail alert
async function sendGmailAlert(failureData) {
  try {
    const authClient = await auth.getClient();
    google.options({ auth: authClient });

    const emailContent = `
Subject: 🚨 Payment Failed Alert - ${failureData.customerEmail}
To: ${process.env.ALERT_EMAIL || 'your-email@example.com'}
Content-Type: text/html; charset=utf-8

<html>
<body>
  <h2>🚨 Payment Failure Alert</h2>
  <p>A payment has failed and requires attention:</p>
  
  <table border="1" cellpadding="10" cellspacing="0">
    <tr><td><strong>Payment ID:</strong></td><td>${failureData.paymentId}</td></tr>
    <tr><td><strong>Customer:</strong></td><td>${failureData.customerName} (${failureData.customerEmail})</td></tr>
    <tr><td><strong>Amount:</strong></td><td>${failureData.amount} ${failureData.currency.toUpperCase()}</td></tr>
    <tr><td><strong>Failure Reason:</strong></td><td>${failureData.failureReason}</td></tr>
    <tr><td><strong>Failed At:</strong></td><td>${failureData.failedAt}</td></tr>
  </table>
  
  <p><strong>Action Required:</strong> Please review this failed payment and take appropriate action.</p>
  
  <p>View in Stripe Dashboard: <a href="https://dashboard.stripe.com/payments/${failureData.paymentId}">Click here</a></p>
</body>
</html>`;

    const encodedEmail = Buffer.from(emailContent).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedEmail
      }
    });

    addLog(`Email alert sent for payment failure: ${failureData.paymentId}`);
    return true;
  } catch (error) {
    addLog(`Failed to send email alert: ${error.message}`, 'error');
    return false;
  }
}

// Update Airtable with failed payment
async function updateAirtableRecord(failureData) {
  try {
    const record = await base('Failed Payments').create({
      'Payment ID': failureData.paymentId,
      'Customer Email': failureData.customerEmail,
      'Customer Name': failureData.customerName,
      'Amount': failureData.amount / 100, // Convert cents to dollars
      'Currency': failureData.currency.toUpperCase(),
      'Failure Reason': failureData.failureReason,
      'Failed At': failureData.failedAt,
      'Status': 'Failed'
    });

    addLog(`Created Airtable record for failed payment: ${record.id}`);
    return record;
  } catch (error) {
    addLog(`Failed to create Airtable record: ${error.message}`, 'error');
    return null;
  }
}

// Process failed payment
async function processFailedPayment(paymentIntent) {
  try {
    const customer = paymentIntent.customer ? 
      await stripe.customers.retrieve(paymentIntent.customer) : 
      { email: 'Unknown', name: 'Unknown Customer' };

    const failureData = {
      paymentId: paymentIntent.id,
      customerEmail: customer.email || 'Unknown',
      customerName: customer.name || customer.email || 'Unknown Customer',
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      failureReason: paymentIntent.last_payment_error?.message || 'Unknown error',
      failedAt: new Date().toISOString()
    };

    addLog(`Processing failed payment: ${failureData.paymentId} for ${failureData.customerEmail}`);

    // Send email alert
    await sendGmailAlert(failureData);

    // Update Airtable
    await updateAirtableRecord(failureData);

    addLog(`Successfully processed failed payment: ${failureData.paymentId}`);
  } catch (error) {
    addLog(`Error processing failed payment: ${error.message}`, 'error');
  }
}

// Stripe webhook endpoint
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    addLog(`Webhook signature verification failed: ${err.message}`, 'error');
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  addLog(`Received webhook event: ${event.type}`);

  // Handle failed payments
  switch (event.type) {
    case 'payment_intent.payment_failed':
      await processFailedPayment(event.data.object);
      break;
    case 'charge.failed':
      // Handle charge failures if needed
      addLog(`Charge failed: ${event.data.object.id}`);
      break;
    case 'invoice.payment_failed':
      // Handle invoice payment failures if needed
      addLog(`Invoice payment failed: ${event.data.object.id}`);
      break;
    default:
      addLog(`Unhandled event type: ${event.type}`, 'warning');
  }

  res.json({ received: true });
});

// Status endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'Active',
    service: 'Stripe Payment Failure Monitor',
    endpoints: {
      '/': 'Status and available endpoints',
      '/health': 'Health check',
      '/logs': 'View recent logs',
      '/test': 'Manual test run (POST)',
      '/webhook': 'Stripe webhook endpoint (POST)'
    },
    features: [
      'Monitors Stripe for failed payments',
      'Sends Gmail alerts for failures',
      'Updates Airtable Failed Payments table',
      'Webhook event processing'
    ],
    lastActivity: recentLogs[0]?.timestamp || 'No activity yet'
  });
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Test Stripe connection
    await stripe.customers.list({ limit: 1 });
    
    // Test Airtable connection
    await base('Failed Payments').select({ maxRecords: 1 }).firstPage();
    
    // Test Gmail connection
    const authClient = await auth.getClient();
    
    res.json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      services: {
        stripe: 'connected',
        airtable: 'connected', 
        gmail: 'connected'
      }
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'unhealthy', 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Logs endpoint
app.get('/logs', (req, res) => {
  res.json({
    logs: recentLogs.slice(0, 20),
    total: recentLogs.length
  });
});

// Manual test endpoint
app.post('/test', async (req, res) => {
  try {
    addLog('Manual test initiated');
    
    // Create a test record to verify everything works
    const testData = {
      paymentId: `test_${Date.now()}`,
      customerEmail: process.env.ALERT_EMAIL || 'test@example.com',
      customerName: 'Test Customer',
      amount: 2999, // $29.99 in cents
      currency: 'usd',
      failureReason: 'Test failure - manual test run',
      failedAt: new Date().toISOString()
    };

    // Test email sending
    const emailSent = await sendGmailAlert(testData);
    
    // Test Airtable update
    const airtableRecord = await updateAirtableRecord(testData);
    
    res.json({
      success: true,
      message: 'Test completed',
      results: {
        emailSent,
        airtableRecord: airtableRecord ? airtableRecord.id : null
      }
    });
  } catch (error) {
    addLog(`Test failed: ${error.message}`, 'error');
    res.status(500).json({ success: false, error: error.message });
  }
});

// Initialize app
app.listen(port, async () => {
  addLog(`Stripe Payment Monitor started on port ${port}`);
  await ensureFailedPaymentsTable();
  addLog('Ready to monitor payment failures');
});