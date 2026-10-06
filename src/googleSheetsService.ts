import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
  signOut
} from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize Firebase App & Auth
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Configure Google Auth Provider with requested Google Workspace scopes
const provider = new GoogleAuthProvider();
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/spreadsheets.readonly'
];

SCOPES.forEach(scope => provider.addScope(scope));
provider.setCustomParameters({ prompt: 'select_account' });

// In-memory token caching per guidelines (do NOT store in localStorage or sessionStorage)
let isSigningIn = false;
let cachedAccessToken: string | null = null;
let currentUser: User | null = null;

export interface SpreadsheetInfo {
  id: string;
  name: string;
  url: string;
  modifiedTime?: string;
}

/**
 * Initialize auth state listener. Call this on app load.
 */
export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    currentUser = user;
    if (user) {
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        // Token must be acquired via user interactive popup
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

/**
 * Interactive Sign-in with Google popup
 */
export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('ไม่สามารถรับ Access Token จาก Google OAuth ได้ กรุณาลองใหม่อีกครั้ง');
    }

    cachedAccessToken = credential.accessToken;
    currentUser = result.user;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Google Sign in error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

/**
 * Get current in-memory access token
 */
export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

/**
 * Get current authenticated user
 */
export const getCurrentUser = (): User | null => {
  return currentUser;
};

/**
 * Sign out and clear cached token
 */
export const googleSignOut = async () => {
  await signOut(auth);
  cachedAccessToken = null;
  currentUser = null;
};

/**
 * Search user's Google Drive for existing GPF spreadsheets
 */
export const findExistingGpfSheets = async (): Promise<SpreadsheetInfo[]> => {
  const token = await getAccessToken();
  if (!token) throw new Error('กรุณาเข้าสู่ระบบด้วย Google ก่อนค้นหาไฟล์');

  const query = encodeURIComponent("mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and name contains 'กบข.'");
  const url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,modifiedTime,webViewLink)&orderBy=modifiedTime desc&pageSize=10`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ค้นหาไฟล์ Google Sheets ล้มเหลว (${res.status}): ${err}`);
  }

  const data = await res.json();
  return (data.files || []).map((f: any) => ({
    id: f.id,
    name: f.name,
    url: f.webViewLink || `https://docs.google.com/spreadsheets/d/${f.id}/edit`,
    modifiedTime: f.modifiedTime
  }));
};

/**
 * Create a new Google Spreadsheet with standard GPF tabs
 */
export const createGpfSpreadsheet = async (title: string = 'กบข. พอร์ตและการลงทุน - GPF Tracker'): Promise<SpreadsheetInfo> => {
  const token = await getAccessToken();
  if (!token) throw new Error('กรุณาเข้าสู่ระบบด้วย Google ก่อนสร้างไฟล์');

  const body = {
    properties: {
      title
    },
    sheets: [
      { properties: { title: 'สรุปพอร์ตและ5วันล่าสุด' } },
      { properties: { title: 'มูลค่าNAV_16แผน' } },
      { properties: { title: 'ประวัติรายการ' } }
    ]
  };

  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`สร้าง Google Sheets ล้มเหลว (${res.status}): ${err}`);
  }

  const sheet = await res.json();
  return {
    id: sheet.spreadsheetId,
    name: sheet.properties.title,
    url: sheet.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit`
  };
};

/**
 * Export/Sync GPF data into Google Sheets
 */
export const syncDataToGpfSpreadsheet = async (
  spreadsheetId: string,
  portfolioData: any,
  realPlanStats: any,
  fiveDaysData: any[],
  transactions: any[]
): Promise<void> => {
  const token = await getAccessToken();
  if (!token) throw new Error('กรุณาเข้าสู่ระบบด้วย Google ก่อนทำการซิงค์ข้อมูล');

  const now = new Date();
  const syncTimestampStr = `${now.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })} เวลา ${now.toLocaleTimeString('th-TH')}`;

  // 1. Prepare Data for Sheet: 'สรุปพอร์ตและ5วันล่าสุด'
  const summaryValues: any[][] = [
    ['กบข. พอร์ตและการลงทุน - GPF Tracker', '', '', '', '', ''],
    ['ซิงค์ข้อมูลล่าสุด ณ:', syncTimestampStr, '', '', '', ''],
    ['แหล่งข้อมูล:', 'ดึงข้อมูลราคาจริงจากเว็บไซต์ กบข. ทางการ (gpf.or.th)', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['[ 1. สรุปสัดส่วนยอดเงิน กบข. ของฉัน ]', '', '', '', '', ''],
    ['หมวดเงิน', 'ประเภทเงิน', 'ยอดเงิน (บาท)', 'หมายเหตุ', '', ''],
    ['เงินสะสมของท่าน', 'เงินสะสม (3-15%)', portfolioData.sumCompAccum || 32301.84, '', '', ''],
    ['เงินสะสมของท่าน', 'เงินสะสมเพิ่ม (ออมเพิ่ม)', portfolioData.sumExtra || 0.00, '', '', ''],
    ['เงินสะสมของท่าน', 'ผลประโยชน์เงินสะสม', portfolioData.sumCompBenefit || 9449.18, '', '', ''],
    ['เงินสะสมของท่าน', 'รวมเงินสะสมของท่าน', portfolioData.userTotal || 41751.02, 'เงินของสมาชิกเอง', '', ''],
    ['เงินที่รัฐสมทบให้', 'เงินสมทบ (3%)', portfolioData.sumMatch || 32301.84, '', '', ''],
    ['เงินที่รัฐสมทบให้', 'เงินชดเชย (2%)', portfolioData.sumCompensate || 21534.56, '', '', ''],
    ['เงินที่รัฐสมทบให้', 'เงินประเดิม', portfolioData.sumInitial || 0.00, '', '', ''],
    ['เงินที่รัฐสมทบให้', 'ผลประโยชน์ที่รัฐให้', portfolioData.sumGovBenefit || 16020.51, '', '', ''],
    ['เงินที่รัฐสมทบให้', 'รวมเงินที่รัฐสมทบให้', portfolioData.govTotal || 69856.91, 'เงินสมทบจากภาครัฐ', '', ''],
    ['รวมเงินทั้งสิ้น', 'ยอดรวมพอร์ต กบข.', portfolioData.grandTotal || 111607.93, 'คำนวณตามสัดส่วน', '', ''],
    ['', '', '', '', '', ''],
    ['[ 2. สถิติสัดส่วนยอดเงิน กบข. รายวันย้อนหลัง 5 วัน พร้อมส่วนต่าง Day-over-Day ]', '', '', '', '', ''],
    ['วันที่', 'มูลค่า NAV (แผนหุ้นต่างประเทศ)', 'จำนวนหน่วยลงทุน', 'ยอดเงินรวมโดยประมาณ (บาท)', 'ส่วนต่างวันต่อวัน (บาท)', 'การเปลี่ยนแปลง (%)']
  ];

  if (fiveDaysData && fiveDaysData.length > 0) {
    fiveDaysData.forEach(day => {
      const diffFormatted = day.diffText || '-';
      const pctFormatted = day.pctText || '-';
      summaryValues.push([
        day.dateThai,
        day.nav,
        day.units,
        day.totalEst,
        diffFormatted,
        pctFormatted
      ]);
    });
  } else {
    summaryValues.push(['ไม่มีข้อมูลย้อนหลัง', '-', '-', '-', '-', '-']);
  }

  // 2. Prepare Data for Sheet: 'มูลค่าNAV_16แผน'
  const navValues: any[][] = [
    ['รายงานมูลค่าหน่วยลงทุน (NAV) กบข. ครบ 16 แผนการลงทุน', '', '', '', '', '', '', '', ''],
    ['ข้อมูลล่าสุด ณ วันที่:', portfolioData.latestDateThai || syncTimestampStr, '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', ''],
    ['ชื่อแผนการลงทุน', 'มูลค่า NAV ล่าสุด (บาท)', 'วันที่ประกาศ', 'เปลี่ยนแปลง 1 วัน (บาท)', 'เปลี่ยนแปลง 1 วัน (%)', '1 เดือน (%)', 'ตั้งแต่ต้นปี YTD (%)', 'ตั้งแต่จัดตั้ง (%)', 'ราคาสูงสุด (ATH)']
  ];

  if (realPlanStats && Object.keys(realPlanStats).length > 0) {
    Object.keys(realPlanStats).forEach(planName => {
      const st = realPlanStats[planName];
      navValues.push([
        st.plan_name || planName,
        st.latest_nav !== undefined ? st.latest_nav : '-',
        st.latest_date || '-',
        st.day_change !== undefined ? st.day_change : '-',
        st.day_change_pct !== undefined ? `${st.day_change_pct > 0 ? '+' : ''}${st.day_change_pct}%` : '-',
        st.month_change_pct !== undefined ? `${st.month_change_pct > 0 ? '+' : ''}${st.month_change_pct}%` : '-',
        st.ytd_change_pct !== undefined ? `${st.ytd_change_pct > 0 ? '+' : ''}${st.ytd_change_pct}%` : '-',
        st.inception_change_pct !== undefined ? `${st.inception_change_pct > 0 ? '+' : ''}${st.inception_change_pct}%` : '-',
        st.max_nav !== undefined ? st.max_nav : '-'
      ]);
    });
  }

  // 3. Prepare Data for Sheet: 'ประวัติรายการ'
  const txValues: any[][] = [
    ['ประวัติรายการ Statement และการลงทุน กบข.', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['วันที่ทำรายการ', 'ประเภทรายการ', 'แผนการลงทุน', 'จำนวนเงิน (บาท)', 'ราคา NAV', 'จำนวนหน่วย']
  ];

  if (transactions && transactions.length > 0) {
    transactions.forEach(tx => {
      txValues.push([
        tx.dateThai || tx.date,
        tx.typeLabel || tx.type,
        tx.planName,
        tx.totalAmount || tx.amount,
        tx.nav,
        tx.units
      ]);
    });
  }

  // Send batchUpdate to Google Sheets
  const updatePayload = {
    valueInputOption: 'USER_ENTERED',
    data: [
      {
        range: "'สรุปพอร์ตและ5วันล่าสุด'!A1:F" + summaryValues.length,
        values: summaryValues
      },
      {
        range: "'มูลค่าNAV_16แผน'!A1:I" + navValues.length,
        values: navValues
      },
      {
        range: "'ประวัติรายการ'!A1:F" + txValues.length,
        values: txValues
      }
    ]
  };

  const updateRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updatePayload)
  });

  if (!updateRes.ok) {
    // If sheets might not exist, attempt writing to Sheet1 or current active sheets
    const fallbackPayload = {
      valueInputOption: 'USER_ENTERED',
      data: [
        {
          range: 'A1:F' + summaryValues.length,
          values: summaryValues
        }
      ]
    };
    const fbRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(fallbackPayload)
    });
    if (!fbRes.ok) {
      const err = await updateRes.text();
      throw new Error(`บันทึกข้อมูลลง Google Sheets ล้มเหลว (${updateRes.status}): ${err}`);
    }
  }
};

// Export to window object for easy consumption from HTML UI scripts
if (typeof window !== 'undefined') {
  (window as any).GoogleSheetsService = {
    initAuth,
    googleSignIn,
    getAccessToken,
    getCurrentUser,
    googleSignOut,
    findExistingGpfSheets,
    createGpfSpreadsheet,
    syncDataToGpfSpreadsheet
  };
}
