NAME = proj
CC = cc
CFLAGS = -Wall -Wextra -Werror -Iincludes
SRCS = main.c src/ft_strlen.c src/str/ft_strdup.c src/list/ft_lst.c
OBJS = $(SRCS:.c=.o)

all: $(NAME)

$(NAME): $(OBJS)
	$(CC) $(CFLAGS) $(OBJS) -o $(NAME) 

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -f $(OBJS)

fclean: clean
	rm -f $(NAME)

re: fclean all

.PHONY: all clean fclean re
