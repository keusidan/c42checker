/**
 * 標準ヘッダ (と、よく使う POSIX ヘッダ) が提供する名前。「使っていないヘッダの include は禁止」(Norm III.5 の (*)) の判定に使う。
 * 表にないヘッダ (mlx.h や readline/readline.h など) は、使われているかを判定しない。
 * 同じ名前を複数のヘッダが提供するもの (size_t、NULL など) は、どのヘッダにも載せてある。= 判定は甘い側に倒している。
 */
const w = (s: string): string[] => s.split(/\s+/).filter(Boolean);

const SIZE_TYPES = 'size_t';

export const STD_HEADERS: Record<string, string[]> = {
  'stdlib.h': w(`${SIZE_TYPES} wchar_t NULL malloc calloc realloc free exit abort atexit _Exit getenv setenv unsetenv putenv system
    atoi atol atoll atof strtol strtoll strtoul strtoull strtod strtof strtold rand srand RAND_MAX qsort bsearch abs labs llabs div ldiv lldiv
    EXIT_SUCCESS EXIT_FAILURE MB_CUR_MAX mblen mbtowc wctomb mbstowcs wcstombs div_t ldiv_t lldiv_t realpath mkstemp mkdtemp posix_memalign
    aligned_alloc random srandom drand48 arc4random arc4random_uniform reallocarray`),
  'stdio.h': w(`${SIZE_TYPES} NULL FILE EOF BUFSIZ stdin stdout stderr printf fprintf dprintf sprintf snprintf vprintf vfprintf vsprintf vsnprintf
    scanf fscanf sscanf puts fputs fputc putc putchar getc getchar fgetc fgets gets fopen fclose fflush fread fwrite fseek ftell rewind
    perror remove rename tmpfile tmpnam setbuf setvbuf ungetc feof ferror clearerr fileno fdopen popen pclose getline getdelim
    SEEK_SET SEEK_CUR SEEK_END fpos_t fgetpos fsetpos asprintf vasprintf`),
  'string.h': w(`${SIZE_TYPES} NULL memcpy memmove memset memcmp memchr strlen strnlen strcpy strncpy strcat strncat strcmp strncmp strchr strrchr
    strstr strtok strtok_r strdup strndup strerror strspn strcspn strpbrk strcoll strxfrm strsep strlcpy strlcat strcasecmp strncasecmp
    strsignal memccpy mempcpy`),
  'strings.h': w(`${SIZE_TYPES} bzero bcopy bcmp index rindex strcasecmp strncasecmp ffs`),
  'unistd.h': w(`${SIZE_TYPES} ssize_t off_t pid_t uid_t gid_t useconds_t intptr_t NULL read write close dup dup2 pipe fork execve execv execvp
    execl execlp execle _exit access unlink rmdir chdir getcwd lseek sleep usleep getpid getppid getuid geteuid getgid isatty ttyname
    sysconf pathconf alarm pause chown fsync fdatasync truncate ftruncate link symlink readlink getopt optarg optind opterr optopt
    STDIN_FILENO STDOUT_FILENO STDERR_FILENO R_OK W_OK X_OK F_OK SEEK_SET SEEK_CUR SEEK_END _SC_PAGESIZE _SC_NPROCESSORS_ONLN gethostname
    getpagesize setsid setuid setgid environ nice sync tcgetpgrp tcsetpgrp getpgrp setpgid`),
  'stddef.h': w(`${SIZE_TYPES} ptrdiff_t wchar_t NULL offsetof max_align_t`),
  'stdint.h': w(`int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t intptr_t uintptr_t intmax_t uintmax_t int_least8_t
    int_least16_t int_least32_t int_least64_t uint_least8_t uint_least16_t uint_least32_t uint_least64_t int_fast8_t int_fast16_t int_fast32_t
    int_fast64_t uint_fast8_t uint_fast16_t uint_fast32_t uint_fast64_t INT8_MAX INT8_MIN INT16_MAX INT16_MIN INT32_MAX INT32_MIN INT64_MAX
    INT64_MIN UINT8_MAX UINT16_MAX UINT32_MAX UINT64_MAX SIZE_MAX INTPTR_MAX INTPTR_MIN UINTPTR_MAX INTMAX_MAX INTMAX_MIN UINTMAX_MAX
    INT8_C INT16_C INT32_C INT64_C UINT8_C UINT16_C UINT32_C UINT64_C`),
  'inttypes.h': w(`int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t intptr_t uintptr_t intmax_t uintmax_t PRId8 PRId16 PRId32
    PRId64 PRIu8 PRIu16 PRIu32 PRIu64 PRIx32 PRIx64 PRIi32 PRIi64 PRIX32 PRIX64 strtoimax strtoumax imaxabs imaxdiv`),
  'limits.h': w(`CHAR_BIT CHAR_MAX CHAR_MIN SCHAR_MAX SCHAR_MIN UCHAR_MAX SHRT_MAX SHRT_MIN USHRT_MAX INT_MAX INT_MIN UINT_MAX LONG_MAX LONG_MIN
    ULONG_MAX LLONG_MAX LLONG_MIN ULLONG_MAX SSIZE_MAX PATH_MAX NAME_MAX MB_LEN_MAX PIPE_BUF ARG_MAX OPEN_MAX`),
  'float.h': w(`FLT_MAX FLT_MIN FLT_EPSILON DBL_MAX DBL_MIN DBL_EPSILON LDBL_MAX LDBL_MIN LDBL_EPSILON FLT_DIG DBL_DIG FLT_MANT_DIG DBL_MANT_DIG`),
  'stdbool.h': w('bool true false __bool_true_false_are_defined'),
  'stdarg.h': w('va_list va_start va_arg va_end va_copy'),
  'ctype.h': w(`isalnum isalpha isascii isblank iscntrl isdigit isgraph islower isprint ispunct isspace isupper isxdigit tolower toupper toascii`),
  'math.h': w(`sin cos tan asin acos atan atan2 sinh cosh tanh exp exp2 log log2 log10 pow sqrt cbrt hypot ceil floor round trunc fabs fmod
    sinf cosf tanf sqrtf powf fabsf floorf ceilf roundf lround llround rint nearbyint copysign nan isnan isinf isfinite signbit fmax fmin fdim
    M_PI M_PI_2 M_PI_4 M_E M_SQRT2 M_LN2 M_LN10 HUGE_VAL INFINITY NAN float_t double_t FP_NAN FP_INFINITE FP_ZERO frexp ldexp modf expm1 log1p`),
  'errno.h': w(`errno EACCES EAGAIN EBADF EBUSY ECHILD EEXIST EFAULT EINTR EINVAL EIO EISDIR EMFILE ENFILE ENOENT ENOEXEC ENOMEM ENOSPC ENOTDIR
    ENOTTY EPERM EPIPE ERANGE EDOM EWOULDBLOCK ETIMEDOUT ECONNREFUSED`),
  'fcntl.h': w(`open openat creat fcntl O_RDONLY O_WRONLY O_RDWR O_CREAT O_EXCL O_TRUNC O_APPEND O_NONBLOCK O_CLOEXEC O_DIRECTORY O_SYNC O_NOCTTY
    F_GETFL F_SETFL F_GETFD F_SETFD F_DUPFD FD_CLOEXEC AT_FDCWD mode_t off_t pid_t`),
  'sys/types.h': w(`${SIZE_TYPES} ssize_t off_t pid_t uid_t gid_t mode_t dev_t ino_t nlink_t time_t clock_t suseconds_t useconds_t id_t key_t blkcnt_t blksize_t pthread_t u_char u_short u_int u_long`),
  'sys/stat.h': w(`stat fstat lstat mkdir chmod fchmod umask mode_t S_ISDIR S_ISREG S_ISLNK S_IRUSR S_IWUSR S_IXUSR S_IRWXU S_IRGRP S_IWGRP S_IXGRP
    S_IROTH S_IWOTH S_IXOTH S_IRWXG S_IRWXO S_IFMT S_IFDIR S_IFREG mkfifo st_mode st_size`),
  'sys/wait.h': w(`wait waitpid wait3 wait4 WIFEXITED WEXITSTATUS WIFSIGNALED WTERMSIG WNOHANG WUNTRACED WIFSTOPPED WSTOPSIG WCOREDUMP pid_t`),
  'sys/time.h': w(`gettimeofday settimeofday timeval timezone timersub timeradd timercmp itimerval setitimer getitimer time_t suseconds_t`),
  'sys/mman.h': w(`mmap munmap mprotect msync mlock munlock PROT_READ PROT_WRITE PROT_EXEC PROT_NONE MAP_SHARED MAP_PRIVATE MAP_ANONYMOUS MAP_ANON MAP_FAILED`),
  'sys/select.h': w(`select fd_set FD_SET FD_CLR FD_ISSET FD_ZERO FD_SETSIZE pselect timeval`),
  'sys/socket.h': w(`socket bind listen accept connect send recv sendto recvfrom setsockopt getsockopt shutdown socklen_t sockaddr sockaddr_storage
    AF_INET AF_INET6 AF_UNIX SOCK_STREAM SOCK_DGRAM SOL_SOCKET SO_REUSEADDR SOMAXCONN`),
  'sys/ioctl.h': w('ioctl TIOCGWINSZ winsize'),
  'time.h': w(`${SIZE_TYPES} NULL time_t clock_t timespec tm time clock difftime mktime localtime gmtime asctime ctime strftime nanosleep
    clock_gettime CLOCK_MONOTONIC CLOCK_REALTIME CLOCKS_PER_SEC localtime_r gmtime_r`),
  'signal.h': w(`signal sigaction sigemptyset sigfillset sigaddset sigdelset sigismember sigprocmask kill raise sigset_t siginfo_t sig_atomic_t
    SIGINT SIGTERM SIGQUIT SIGKILL SIGUSR1 SIGUSR2 SIGCHLD SIGPIPE SIGALRM SIGHUP SIGSEGV SIGSTOP SIGCONT SIG_DFL SIG_IGN SA_SIGINFO SA_RESTART
    SIG_BLOCK SIG_UNBLOCK SIG_SETMASK pid_t sighandler_t`),
  'pthread.h': w(`pthread_t pthread_create pthread_join pthread_detach pthread_exit pthread_self pthread_mutex_t pthread_mutex_init pthread_mutex_lock
    pthread_mutex_unlock pthread_mutex_destroy pthread_mutex_trylock pthread_cond_t pthread_cond_init pthread_cond_wait pthread_cond_signal
    pthread_cond_broadcast pthread_cond_destroy pthread_attr_t pthread_attr_init pthread_once PTHREAD_MUTEX_INITIALIZER pthread_mutexattr_t`),
  'semaphore.h': w('sem_t sem_open sem_close sem_unlink sem_wait sem_post sem_init sem_destroy sem_trywait SEM_FAILED'),
  'dirent.h': w('DIR dirent opendir readdir closedir rewinddir scandir DT_DIR DT_REG DT_LNK d_name d_type'),
  'termios.h': w(`termios tcgetattr tcsetattr cfmakeraw ECHO ICANON ISIG TCSANOW TCSADRAIN TCSAFLUSH VMIN VTIME ICRNL OPOST IXON`),
  'locale.h': w('setlocale localeconv LC_ALL LC_CTYPE LC_NUMERIC LC_COLLATE'),
  'assert.h': w('assert static_assert NDEBUG'),
  'setjmp.h': w('jmp_buf setjmp longjmp'),
  'wchar.h': w(`${SIZE_TYPES} wchar_t wint_t NULL wcslen wcscpy wcscmp wprintf fwprintf mbstate_t`),
  'netdb.h': w('getaddrinfo freeaddrinfo gai_strerror addrinfo gethostbyname hostent getnameinfo AI_PASSIVE'),
  'arpa/inet.h': w('inet_addr inet_ntoa inet_pton inet_ntop htons htonl ntohs ntohl in_addr_t'),
  'netinet/in.h': w('sockaddr_in sockaddr_in6 in_addr INADDR_ANY IPPROTO_TCP IPPROTO_UDP htons htonl ntohs ntohl in_port_t'),
  'bsd/bsd.h': w('strlcpy strlcat'),
  'bsd/string.h': w('strlcpy strlcat'),
};

/** 名前が全て大文字 (定数の可能性が高い) の標準マクロ。#define の値が定数かの判定で、既知の定数として扱う */
export const STD_CONSTANTS: ReadonlySet<string> = new Set(
  Object.values(STD_HEADERS)
    .flat()
    .filter((n) => /^[A-Z][A-Z0-9_]*$/.test(n)),
);

/** include されたヘッダ (<x.h> の x.h) が、表にあるか */
export function isKnownSystemHeader(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(STD_HEADERS, name);
}
