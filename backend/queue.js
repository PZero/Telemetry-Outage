// In-Memory Request Queue with Coalescing and Throttling for Azure REST Gateway calls.

let queue = [];
let activeWorkerCount = 0;
const MAX_CONCURRENT_AZURE_CALLS = 2;
const THROTTLE_DELAY_MS = 1000;

/**
 * Helper to construct a unique job key to match identical requests.
 */
function getJobKey(endpoint, body) {
  const upId = body.upId || (body.upname && body.upname[0]) || 'unknown';
  const type = body.type || 'outage';
  
  if (endpoint.includes('observation')) {
    const date = body.date || 'bulk';
    return `${upId}|${date}|${type}`;
  } else if (endpoint.includes('outage')) {
    const startDate = body.startDate || body.fromDate_UTC || 'bulk';
    const endDate = body.endDate || body.toDate_UTC || 'bulk';
    return `${upId}|${startDate}|${endDate}|outage`;
  }
  return `${upId}|${Date.now()}`;
}

/**
 * Enqueues a request for execution. 
 * If an identical request is already queued or processing, coalesces them.
 * 
 * @param {string} endpoint Target API URL path
 * @param {Object} body Original client request payload
 * @param {Function} proxyFn Async function wrapping the actual fetch to Azure
 * @returns {Promise<Object>} Resolves with the Azure API response
 */
export function enqueueRequest(endpoint, body, proxyFn) {
  const key = getJobKey(endpoint, body);
  
  // 1. Check for request coalescing (is there an active identical job?)
  const existingJob = queue.find(q => q.key === key && (q.status === 'pending' || q.status === 'processing'));
  
  if (existingJob) {
    console.log(`[Queue] Coalescing request for key: ${key}. Job ID: ${existingJob.id}`);
    return new Promise((resolve, reject) => {
      existingJob.listeners.push({ resolve, reject });
    });
  }

  // 2. Create a new job if none exists
  const job = {
    id: Math.random().toString(36).substring(2, 9),
    key,
    endpoint,
    body,
    proxyFn,
    status: 'pending',
    listeners: []
  };

  console.log(`[Queue] Enqueuing new job ${job.id} for key: ${key}. Queue length: ${queue.length + 1}`);
  queue.push(job);
  
  // Trigger worker loop
  triggerWorker();

  return new Promise((resolve, reject) => {
    job.listeners.push({ resolve, reject });
  });
}

/**
 * Main worker loop processing jobs with concurrency limits and throttling.
 */
function triggerWorker() {
  if (activeWorkerCount >= MAX_CONCURRENT_AZURE_CALLS) {
    return;
  }

  const nextJob = queue.find(q => q.status === 'pending');
  if (!nextJob) {
    return;
  }

  nextJob.status = 'processing';
  activeWorkerCount++;

  console.log(`[Queue Worker] Starting job ${nextJob.id} for key: ${nextJob.key}. Active: ${activeWorkerCount}/${MAX_CONCURRENT_AZURE_CALLS}`);

  (async () => {
    try {
      const result = await nextJob.proxyFn();
      nextJob.status = 'completed';
      nextJob.listeners.forEach(l => l.resolve(result));
    } catch (err) {
      console.error(`[Queue Worker] Job ${nextJob.id} failed:`, err.message);
      nextJob.status = 'failed';
      nextJob.listeners.forEach(l => l.reject(err));
    } finally {
      activeWorkerCount--;
      // Remove completed job from the queue list
      queue = queue.filter(q => q.id !== nextJob.id);
      
      // Delay before starting next job in this slot to prevent Azure AD/API rate limit locks
      setTimeout(() => {
        triggerWorker();
      }, THROTTLE_DELAY_MS);
    }
  })();
}

/**
 * Retrieves the status of the queue.
 * Optionally checks the position of a specific request matching the criteria.
 */
export function getQueueStatus(upId, date, type, startDate, endDate) {
  // Construct the lookup key based on parameters
  let lookupKey = null;
  if (upId && date && type) {
    lookupKey = `${upId}|${date}|${type}`;
  } else if (upId && startDate && endDate) {
    lookupKey = `${upId}|${startDate}|${endDate}|outage`;
  }

  // Find index of job (0-indexed)
  let position = 0;
  if (lookupKey) {
    const idx = queue.findIndex(q => q.key === lookupKey);
    if (idx !== -1) {
      position = idx + 1; // Convert to 1-indexed position
    }
  }

  const activeJobs = queue
    .filter(q => q.status === 'processing')
    .map(q => ({ id: q.id, key: q.key }));

  return {
    queueLength: queue.length,
    activeCount: activeJobs.length,
    activeJobs,
    position
  };
}
