const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { nanoid } = require('nanoid');

const RECEIPTS_DIR = path.join(__dirname, '..', '..', 'uploads', 'receipts');
const MENU_ICONS_DIR = path.join(__dirname, '..', '..', 'uploads', 'menu-icons');
fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
fs.mkdirSync(MENU_ICONS_DIR, { recursive: true });

const imageFileFilter = (req, file, cb) => {
  const ok = /^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype);
  cb(ok ? null : new Error('Only image uploads are allowed'), ok);
};

function diskStorageFor(dir) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}-${nanoid(8)}${ext}`);
    },
  });
}

// Configurable — receipts are as often a full-resolution camera photo of a
// bank screen as a screenshot, and modern phone cameras routinely produce
// 8-15MB (8192-15360KB) JPEGs. Defaults to 15360KB if RECEIPT_MAX_FILE_SIZE_KB
// is unset or not a positive number. Also drives nginx's client_max_body_size
// (see idea_pad/deploy.sh, which needs its own headroom on top of this) and
// is echoed to the frontend via GET /api/payment-info (see index.js) so the
// upload form can show and enforce the same limit before ever hitting the
// network.
const parsedMaxKB = Number(process.env.RECEIPT_MAX_FILE_SIZE_KB);
const RECEIPT_MAX_FILE_SIZE_KB = parsedMaxKB > 0 ? parsedMaxKB : 15360;
const RECEIPT_MAX_BYTES = RECEIPT_MAX_FILE_SIZE_KB * 1024;

const uploadReceipt = multer({
  storage: diskStorageFor(RECEIPTS_DIR),
  limits: { fileSize: RECEIPT_MAX_BYTES },
  fileFilter: imageFileFilter,
});

const uploadMenuIcon = multer({
  storage: diskStorageFor(MENU_ICONS_DIR),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

module.exports = { uploadReceipt, uploadMenuIcon, RECEIPTS_DIR, MENU_ICONS_DIR, RECEIPT_MAX_BYTES, RECEIPT_MAX_FILE_SIZE_KB };
