import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

/**
 * dayjs pre-extended with the UTC plugin. Analytics "days" are always UTC
 * boundaries so stats stay consistent regardless of the host timezone.
 */
dayjs.extend(utc);

export default dayjs;
